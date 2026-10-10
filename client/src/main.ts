import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { resolveToken } from './lib/stores.svelte.js';

// Resolve the bearer token (Requirement 3.1 precedence) BEFORE mounting the app,
// so child components that fetch on `onMount` (e.g. SessionList) already see the
// resolved token. Svelte fires child `onMount` before the parent's, so resolving
// inside App.onMount would race the first authenticated request.
resolveToken();

const target = document.getElementById('app');
if (!target) {
  throw new Error('Mount target #app not found');
}

const app = mount(App, { target });

export default app;
