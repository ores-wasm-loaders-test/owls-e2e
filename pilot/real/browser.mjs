// Deterministic fixture staging precedes strict manifest admission and the real matrix.
import './no-service-worker.mjs';
await import('./matrix.mjs');
