use leptos::prelude::*;

/// Genuine Leptos SSR island: the browser test must click this actual rendered control.
#[island]
pub fn PilotCounter() -> impl IntoView {
    let (count, set_count) = signal(0_u32);
    view! {
        <section aria-label="Rust pilot">
            <h2>"Rust HTML-first island"</h2>
            <button id="rust-inc" on:click=move |_| set_count.update(|n| *n += 1)>
                "Increment Rust"
            </button>
            <output id="rust-count" aria-live="polite">{move || count.get()}</output>
        </section>
    }
}

#[cfg(feature = "hydrate")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn hydrate_islands() {
    // Root context only. The matching build's data-component exports are invoked by
    // the explicit fixture hydration hook, as in Leptos 0.8.2 island_script.js.
    leptos::mount::hydrate_islands();
}
