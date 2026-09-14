// js/main.js
// Entry point loaded by app.html. Wires the shared shell chrome once,
// then hands off to the router to mount whichever view the URL asks for.

import { initShell } from './shell.js';
import { initRouter } from './router.js';

initShell();
initRouter();
