use hydration_context::SsrSharedContext;
use leptos::prelude::*;
use owls_pilot_island::PilotCounter;
use std::sync::Arc;

fn main() {
    if std::env::args_os().len() != 1 {
        eprintln!("render accepts no command-line options");
        std::process::exit(2);
    }
    let owner = Owner::new_root(Some(Arc::new(SsrSharedContext::new_islands())));
    let html = owner.with(|| view! { <PilotCounter/> }.to_html());
    assert!(html.contains("leptos-island"), "SSR must emit actual island markup");
    assert!(html.contains("data-component="), "SSR must name its matching generated export");
    println!("{html}");
}
