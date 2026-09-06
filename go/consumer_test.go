package consumer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

type Asset struct {
	ID      string `json:"id"`
	URL     string `json:"url"`
	Kind    string `json:"kind"`
	Bytes   int    `json:"bytes"`
	SHA256  string `json:"sha256"`
	Prepare bool   `json:"prepare"`
	Stage   string `json:"stage,omitempty"`
	Role    string `json:"role,omitempty"`
}

type Release struct {
	SchemaVersion int     `json:"schemaVersion"`
	AppID         string  `json:"appId"`
	Release       string  `json:"release"`
	Runtime       string  `json:"runtime"`
	Entrypoint    string  `json:"entrypoint"`
	Assets        []Asset `json:"assets"`
}

type corpusCase struct {
	Name    string          `json:"name"`
	Expect  string          `json:"expect"`
	Origins []string        `json:"origins"`
	Release json.RawMessage `json:"release"`
}

type corpus struct {
	SchemaVersion int          `json:"schemaVersion"`
	Cases         []corpusCase `json:"cases"`
}

var digestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func parseRelease(raw json.RawMessage, origins []string) (Release, error) {
	var release Release
	if err := json.Unmarshal(raw, &release); err != nil {
		return Release{}, err
	}
	if release.SchemaVersion != 1 && release.SchemaVersion != 2 {
		return Release{}, fmt.Errorf("unsupported schemaVersion %d", release.SchemaVersion)
	}
	if release.AppID == "" || release.Release == "" || release.Entrypoint == "" || len(release.Assets) == 0 {
		return Release{}, errors.New("missing release identity, entrypoint, or assets")
	}
	if release.Runtime != "raw-wasm" && release.Runtime != "wasm-bindgen" && release.Runtime != "flutter-web" {
		return Release{}, fmt.Errorf("unsupported runtime %q", release.Runtime)
	}

	allowedOrigins := make(map[string]struct{}, len(origins))
	for _, origin := range origins {
		allowedOrigins[origin] = struct{}{}
	}
	ids := map[string]struct{}{}
	urls := map[string]struct{}{}
	var entry *Asset
	hasWasmModule := false
	for index := range release.Assets {
		asset := &release.Assets[index]
		if asset.ID == "" || asset.Bytes < 1 || !digestPattern.MatchString(asset.SHA256) {
			return Release{}, fmt.Errorf("invalid asset %q", asset.ID)
		}
		if _, duplicate := ids[asset.ID]; duplicate {
			return Release{}, fmt.Errorf("duplicate asset id %q", asset.ID)
		}
		if _, duplicate := urls[asset.URL]; duplicate {
			return Release{}, fmt.Errorf("duplicate asset URL %q", asset.URL)
		}
		ids[asset.ID] = struct{}{}
		urls[asset.URL] = struct{}{}

		parsed, err := url.Parse(asset.URL)
		if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
			return Release{}, fmt.Errorf("asset %q has a non-canonical HTTPS URL", asset.ID)
		}
		origin := parsed.Scheme + "://" + parsed.Host
		if _, ok := allowedOrigins[origin]; !ok {
			return Release{}, fmt.Errorf("asset %q origin %q is not allowed", asset.ID, origin)
		}
		if asset.ID == release.Entrypoint {
			entry = asset
		}
		if asset.Kind == "wasm" && (asset.Role == "module" || asset.Role == "") {
			hasWasmModule = true
		}
	}
	if entry == nil {
		return Release{}, errors.New("entrypoint is not a declared asset")
	}
	expectedKind := map[string]string{"raw-wasm": "wasm", "wasm-bindgen": "module", "flutter-web": "script"}[release.Runtime]
	if entry.Kind != expectedKind {
		return Release{}, fmt.Errorf("entrypoint kind %q does not match %q", entry.Kind, release.Runtime)
	}
	if release.Runtime == "wasm-bindgen" && !hasWasmModule {
		return Release{}, errors.New("wasm-bindgen release has no companion wasm module")
	}
	return release, nil
}

type receipt struct {
	Prepared []string
	Bytes    int
}

type loader struct {
	cache map[string][]byte
	fetch func(context.Context, Asset) ([]byte, error)
}

func (l *loader) prepare(ctx context.Context, release Release) (receipt, error) {
	result := receipt{}
	for _, asset := range release.Assets {
		if !asset.Prepare || asset.Stage == "lazy" {
			continue
		}
		key := asset.URL + "#" + asset.SHA256
		body, ok := l.cache[key]
		if !ok {
			var err error
			body, err = l.fetch(ctx, asset)
			if err != nil {
				return receipt{}, err
			}
		}
		if len(body) != asset.Bytes {
			return receipt{}, fmt.Errorf("asset %q length mismatch", asset.ID)
		}
		sum := sha256.Sum256(body)
		if hex.EncodeToString(sum[:]) != asset.SHA256 {
			return receipt{}, fmt.Errorf("asset %q digest mismatch", asset.ID)
		}
		l.cache[key] = append([]byte(nil), body...)
		result.Prepared = append(result.Prepared, asset.ID)
		result.Bytes += len(body)
	}
	return result, nil
}

func loadCorpus(t *testing.T) corpus {
	t.Helper()
	path := filepath.Join("..", "corpus", "release-corpus.json")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var result corpus
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestEverySharedValidCaseParsesInGo(t *testing.T) {
	data := loadCorpus(t)
	count := 0
	for _, item := range data.Cases {
		if item.Expect != "valid" {
			continue
		}
		count++
		if _, err := parseRelease(item.Release, item.Origins); err != nil {
			t.Errorf("%s: %v", item.Name, err)
		}
	}
	if count != 8 {
		t.Fatalf("expected 8 valid corpus cases, saw %d", count)
	}
}

func TestGoPreparationIsFetchOnlyVerifiedAndCached(t *testing.T) {
	wasm := []byte{0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00}
	sum := sha256.Sum256(wasm)
	release := Release{
		SchemaVersion: 1,
		AppID:         "go-consumer",
		Release:       "2026.09.06",
		Runtime:       "raw-wasm",
		Entrypoint:    "engine",
		Assets: []Asset{{
			ID: "engine", URL: "https://assets.example/engine.wasm", Kind: "wasm",
			Bytes: len(wasm), SHA256: hex.EncodeToString(sum[:]), Prepare: true,
		}},
	}
	calls := 0
	consumer := loader{
		cache: map[string][]byte{},
		fetch: func(ctx context.Context, asset Asset) ([]byte, error) {
			calls++
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			default:
				return append([]byte(nil), wasm...), nil
			}
		},
	}
	first, err := consumer.prepare(context.Background(), release)
	if err != nil {
		t.Fatal(err)
	}
	second, err := consumer.prepare(context.Background(), release)
	if err != nil {
		t.Fatal(err)
	}
	if calls != 1 || first.Bytes != len(wasm) || second.Bytes != len(wasm) || len(first.Prepared) != 1 {
		t.Fatalf("unexpected preparation: calls=%d first=%+v second=%+v", calls, first, second)
	}
}
