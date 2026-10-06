// Marks the page as script-enabled before first paint so [data-reveal]
// content is only hidden when js/page-chrome.js can actually reveal it.
// External file (not inline) because the CSP allows inline scripts only by hash.
document.documentElement.classList.add('js');
