// External-consumer tests for owls_flutter.
//
// The package is imported from zed_modules via the pubspec path dependency, not
// from a sibling source checkout. The corpus in ../corpus/release-corpus.json is
// the shared authority: the same file drives the Node and Rust suites, so any
// verdict this host disagrees on is a real cross-language divergence.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:owls_flutter/owls_flutter.dart';

// ---------------------------------------------------------------- corpus ----

const _corpusRelativePaths = <String>[
  '../corpus/release-corpus.json', // `flutter test` from dart/
  'corpus/release-corpus.json', // `flutter test dart/test` from the repo root
];

class Case {
  Case(this.name, this.expect, this.reason, this.origins, this.release,
      this.code, this.deviationHosts);

  final String name, expect, reason;
  final List<String> origins;
  final Map<String, dynamic> release;
  final String? code;
  final List<String> deviationHosts;

  bool get deviates => deviationHosts.contains('dart');
}

List<Case> loadCorpus() {
  File? found;
  for (final relative in _corpusRelativePaths) {
    final file = File(relative);
    if (file.existsSync()) {
      found = file;
      break;
    }
  }
  if (found == null) {
    throw StateError('release-corpus.json not found from ${Directory.current.path}; '
        'tried ${_corpusRelativePaths.join(", ")}');
  }
  final doc = jsonDecode(found.readAsStringSync()) as Map<String, dynamic>;
  if (doc['schemaVersion'] != 1) {
    throw StateError('unsupported corpus schemaVersion ${doc['schemaVersion']}');
  }
  final cases = (doc['cases'] as List).cast<Map<String, dynamic>>();
  if (cases.isEmpty) throw StateError('corpus is empty');
  return cases
      .map((c) => Case(
            c['name'] as String,
            c['expect'] as String,
            c['reason'] as String,
            (c['origins'] as List).cast<String>(),
            c['release'] as Map<String, dynamic>,
            c['code'] as String?,
            ((c['deviation'] as Map<String, dynamic>?)?['hosts'] as List?)
                    ?.cast<String>() ??
                const <String>[],
          ))
      .toList();
}

// -------------------------------------------------------------- fixtures ----

final Uint8List goodWasm =
    Uint8List.fromList([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
final Uint8List atlas = Uint8List.fromList([0xde, 0xad, 0xbe, 0xef]);

String digest(List<int> bytes) => sha256.convert(bytes).toString();

const origin = 'https://assets.example';
const engineUrl = '$origin/engine.wasm';
const atlasUrl = '$origin/atlas.bin';

Map<String, dynamic> manifest() => {
      'schemaVersion': 1,
      'appId': 'acme-consumer',
      'release': '2026.09.05-e2e',
      'runtime': 'raw-wasm',
      'entrypoint': 'engine',
      'assets': [
        {
          'id': 'engine',
          'url': engineUrl,
          'kind': 'wasm',
          'bytes': goodWasm.length,
          'sha256': digest(goodWasm),
          'prepare': true
        },
        {
          'id': 'atlas',
          'url': atlasUrl,
          'kind': 'data',
          'bytes': atlas.length,
          'sha256': digest(atlas),
          'prepare': true
        }
      ]
    };

LoaderPolicy policy({int maxPrepareBytes = 1 << 20, int maxAssetBytes = 1 << 20}) =>
    LoaderPolicy(
        origins: const [origin],
        maxPrepareBytes: maxPrepareBytes,
        maxAssetBytes: maxAssetBytes,
        timeout: const Duration(seconds: 5));

/// The organization's own CDN client: a private object map, its own accounting,
/// and cooperative cancellation through the host's [Cancellation] token.
class OrgTransport implements AssetTransport {
  OrgTransport(this.objects);

  final Map<String, Uint8List> objects;
  final List<String> requested = [];
  final List<String> cancelled = [];
  Duration hold = Duration.zero;
  Uint8List? poison;

  @override
  Future<Uint8List> fetch(WasmAsset asset, Cancellation cancellation) {
    requested.add(asset.id);
    final body = poison ?? objects[asset.url];
    if (body == null) {
      return Future.error(LoaderException('http', 'no such object: ${asset.url}'));
    }
    if (hold == Duration.zero) {
      cancellation.check();
      return Future.value(Uint8List.fromList(body));
    }
    final completer = Completer<Uint8List>();
    final timer = Timer(hold, () {
      if (!completer.isCompleted) completer.complete(Uint8List.fromList(body));
    });
    cancellation.listen(() {
      timer.cancel();
      cancelled.add(asset.id);
      if (!completer.isCompleted) {
        completer.completeError(
            const LoaderException('cancelled', 'Organization transport stopped'));
      }
    });
    return completer.future;
  }
}

/// The organization's cache. `ByteStore` is get/put only; a bad entry is
/// corrected by the overwrite that follows the refetch.
class OrgStore implements ByteStore {
  final Map<String, Uint8List> entries = {};
  final List<String> ops = [];

  @override
  Future<Uint8List?> get(String digest) async {
    ops.add('get:$digest');
    final value = entries[digest];
    return value == null ? null : Uint8List.fromList(value);
  }

  @override
  Future<void> put(String digest, Uint8List bytes) async {
    ops.add('put:$digest');
    entries[digest] = Uint8List.fromList(bytes);
  }

  int count(String op) => ops.where((o) => o.startsWith('$op:')).length;
}

class CountingAdapter implements WasmAdapter<int> {
  int starts = 0;

  @override
  Future<int> activate(
      WasmRelease release, ReadAsset bytes, Cancellation cancellation) async {
    starts++;
    return (await bytes(release.entrypoint)).length;
  }
}

// ----------------------------------------------------------------- tests ----

void main() {
  final corpus = loadCorpus();

  group('shared corpus', () {
    test('every "valid" case parses into an immutable release', () {
      final valid = corpus.where((c) => c.expect == 'valid').toList();
      expect(valid.length, greaterThanOrEqualTo(5),
          reason: 'corpus must carry at least five valid releases');
      final runtimes = <String>{};
      for (final c in valid) {
        final r = parseRelease(c.release, c.origins);
        runtimes.add(r.runtime);
        expect(r.schemaVersion, 1, reason: c.name);
        expect(r.appId, c.release['appId'], reason: c.name);
        expect(r.release, c.release['release'], reason: c.name);
        expect(r.runtime, c.release['runtime'], reason: c.name);
        expect(r.entrypoint, c.release['entrypoint'], reason: c.name);
        final declared = (c.release['assets'] as List).cast<Map<String, dynamic>>();
        expect(r.assets.length, declared.length, reason: c.name);
        for (var i = 0; i < declared.length; i++) {
          expect(r.assets[i].id, declared[i]['id'], reason: c.name);
          expect(r.assets[i].url, declared[i]['url'], reason: c.name);
          expect(r.assets[i].kind, declared[i]['kind'], reason: c.name);
          expect(r.assets[i].bytes, declared[i]['bytes'], reason: c.name);
          expect(r.assets[i].sha256, declared[i]['sha256'], reason: c.name);
          expect(r.assets[i].prepare, declared[i]['prepare'], reason: c.name);
        }
        expect(() => r.assets.add(r.assets.first), throwsUnsupportedError,
            reason: '${c.name}: the asset list must be unmodifiable');
        expect(() => r.extensions['injected'] = true, throwsUnsupportedError,
            reason: '${c.name}: extensions must be unmodifiable');
      }
      for (final runtime in ['raw-wasm', 'wasm-bindgen', 'flutter-web']) {
        expect(runtimes, contains(runtime),
            reason: 'corpus lacks a valid $runtime release');
      }
    });

    test('every "schema" case is rejected by the JSON Schema layer', () {
      final rejected = corpus.where((c) => c.expect == 'schema').toList();
      expect(rejected, isNotEmpty);
      for (final c in rejected) {
        expect(
            () => parseRelease(c.release, c.origins),
            throwsA(isA<LoaderException>()
                .having((e) => e.code, 'code', 'manifest')),
            reason: '${c.name}: ${c.reason}');
      }
    });

    test('every "host" case passes the schema and fails a host invariant', () {
      final rejected = corpus.where((c) => c.expect == 'host').toList();
      expect(rejected, isNotEmpty);
      for (final c in rejected) {
        expect(
            () => parseRelease(c.release, c.origins),
            throwsA(isA<LoaderException>()
                .having((e) => e.code, 'code', isNot('manifest'))),
            reason: '${c.name}: rejected by the schema layer, so it is '
                'mislabelled expect=host');
        if (c.code != null) {
          expect(
              () => parseRelease(c.release, c.origins),
              throwsA(isA<LoaderException>().having((e) => e.code, 'code', c.code)),
              reason: '${c.name}: ${c.reason}');
        }
      }
    });
  });

  group('organization-supplied extensions', () {
    test('a custom AssetTransport and ByteStore drive the stock host', () async {
      final transport = OrgTransport({engineUrl: goodWasm, atlasUrl: atlas});
      final store = OrgStore();
      final host = WasmHost(manifest(),
          policy: policy(), transport: transport, store: store);

      await host.prefetch();
      expect(transport.requested, ['engine', 'atlas']);
      expect(store.count('put'), 2);
      expect(store.entries[digest(goodWasm)], goodWasm);

      // Verified bytes are reused rather than refetched.
      final bytes = await host.bytes('engine', Cancellation());
      expect(bytes, goodWasm);
      expect(transport.requested.length, 2);
    });

    test('cancellation reaches the organization transport and is recorded',
        () async {
      final transport = OrgTransport({engineUrl: goodWasm, atlasUrl: atlas})
        ..hold = const Duration(seconds: 30);
      final store = OrgStore();
      final host = WasmHost(manifest(),
          policy: policy(), transport: transport, store: store);

      final token = Cancellation();
      final pending = host.prefetch(cancellation: token);
      while (transport.requested.isEmpty) {
        await Future<void>.delayed(Duration.zero);
      }
      token.cancel();

      await expectLater(pending, throwsA(isA<LoaderException>()));
      expect(transport.cancelled, ['engine'],
          reason: 'the transport was told to stop');
      expect(store.count('put'), 0, reason: 'a cancelled fetch caches nothing');

      // Cancellation is not corruption: a fresh token resumes cleanly.
      transport.hold = Duration.zero;
      await host.prefetch(cancellation: Cancellation());
      expect(store.count('put'), 2);
    });

    test('a corrupted cache entry is ignored and the asset is refetched',
        () async {
      final transport = OrgTransport({engineUrl: goodWasm, atlasUrl: atlas});
      final store = OrgStore();
      // The store is content-addressed by digest; poison that slot.
      store.entries[digest(goodWasm)] = Uint8List.fromList([1, 2, 3, 4, 5, 6, 7, 8]);
      final host = WasmHost(manifest(),
          policy: policy(), transport: transport, store: store);

      final bytes = await host.bytes('engine', Cancellation());
      expect(bytes, goodWasm);
      expect(transport.requested, ['engine'], reason: 'the asset was refetched');
      expect(store.entries[digest(goodWasm)], goodWasm,
          reason: 'the good bytes replaced the corrupted entry');
    });

    test('an unverifiable response fails integrity and never reaches the cache',
        () async {
      final transport = OrgTransport({engineUrl: goodWasm})
        ..poison = Uint8List.fromList([0x00, 0x61, 0x73, 0x6d, 0xff, 0xff, 0xff, 0xff]);
      final store = OrgStore();
      final host = WasmHost(manifest(),
          policy: policy(), transport: transport, store: store);

      await expectLater(
          host.bytes('engine', Cancellation()),
          throwsA(isA<LoaderException>()
              .having((e) => e.code, 'code', 'integrity')));
      expect(store.count('put'), 0);
    });

    test('preparation never activates', () async {
      final transport = OrgTransport({engineUrl: goodWasm, atlasUrl: atlas});
      final host = WasmHost(manifest(), policy: policy(), transport: transport);
      final adapter = CountingAdapter();

      await host.prefetch();
      expect(adapter.starts, 0, reason: 'preparation must not reach an adapter');

      expect(await host.activate(adapter), goodWasm.length);
      expect(adapter.starts, 1);
      expect(transport.requested.length, 2,
          reason: 'activation reused the prepared bytes');
    });

    test('budgets and unknown assets are refused before any fetch', () async {
      final transport = OrgTransport({engineUrl: goodWasm, atlasUrl: atlas});
      final host = WasmHost(manifest(),
          policy: policy(maxPrepareBytes: 4), transport: transport);
      await expectLater(host.prefetch(),
          throwsA(isA<LoaderException>().having((e) => e.code, 'code', 'budget')));
      expect(transport.requested, isEmpty);

      final tight = WasmHost(manifest(),
          policy: policy(maxAssetBytes: 4), transport: transport);
      await expectLater(tight.bytes('engine', Cancellation()),
          throwsA(isA<LoaderException>().having((e) => e.code, 'code', 'budget')));
      await expectLater(tight.bytes('nope', Cancellation()),
          throwsA(isA<LoaderException>().having((e) => e.code, 'code', 'asset')));
      expect(transport.requested, isEmpty);
    });

    test('the origin allowlist is the organization\'s decision', () {
      final c = corpus.firstWhere((x) => x.name == 'host-origin-sibling-subdomain');
      expect(
          () => parseRelease(c.release, c.origins),
          throwsA(isA<LoaderException>().having((e) => e.code, 'code', 'origin')));
      final widened = [...c.origins, 'https://cdn.assets.example'];
      expect(parseRelease(c.release, widened).appId, c.release['appId']);
    });
  });
}
