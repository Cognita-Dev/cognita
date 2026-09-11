(function () {
  function enhanceRows() {
    const list =
      document.getElementById(
        'myResourcesList'
      );

    if (!list) return;

    list
      .querySelectorAll(
        '.my-resource-row'
      )
      .forEach((row) => {
        if (
          row.dataset.editorEnhanced ===
          'true'
        ) {
          return;
        }

        row.dataset.editorEnhanced =
          'true';

        const id =
          row.dataset.id;

        if (!id) return;

        const edit =
          document.createElement(
            'a'
          );

        edit.className =
          'my-resource-edit-link';

        edit.href =
          '/resource-editor.html?id=' +
          encodeURIComponent(id);

        edit.innerHTML =
          '<i class="ph ph-pencil-simple"></i>' +
          '<span>Edit</span>';

        edit.addEventListener(
          'click',
          (event) => {
            event.stopPropagation();
          }
        );

        row.insertAdjacentElement(
          'afterend',
          edit
        );
      });
  }

  function init() {
    enhanceRows();

    const list =
      document.getElementById(
        'myResourcesList'
      );

    if (!list) return;

    const observer =
      new MutationObserver(
        enhanceRows
      );

    observer.observe(list, {
      childList: true,
      subtree: true,
    });
  }

  if (
    document.readyState ===
    'loading'
  ) {
    document.addEventListener(
      'DOMContentLoaded',
      init
    );
  } else {
    init();
  }
})();
