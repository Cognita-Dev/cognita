// js/faq.js
// Expand/collapse behavior for .faq-list accordions. Shared by the
// homepage and pricing page so the interaction only has to be written
// (and fixed, if it ever needs fixing) once.
//
// Behavior: within a single .faq-list, only one item is open at a time —
// opening one closes whatever else was open, which keeps a long FAQ from
// turning into a wall of open text. Each list on the page is independent.
// State lives entirely in the "is-open" class + aria-expanded; the actual
// height animation is pure CSS (see the .faq-panel rules in shared.css).

(function initFaqAccordions() {
  function wireList(list) {
    const items = Array.from(list.querySelectorAll('.faq-item'));

    items.forEach((item) => {
      const button = item.querySelector('.faq-question');
      if (!button) return;

      button.addEventListener('click', () => {
        const isOpen = item.classList.contains('is-open');

        items.forEach((other) => {
          if (other !== item && other.classList.contains('is-open')) {
            other.classList.remove('is-open');
            const otherButton = other.querySelector('.faq-question');
            if (otherButton) otherButton.setAttribute('aria-expanded', 'false');
          }
        });

        item.classList.toggle('is-open', !isOpen);
        button.setAttribute('aria-expanded', String(!isOpen));
      });
    });
  }

  document.querySelectorAll('.faq-list').forEach(wireList);
})();
