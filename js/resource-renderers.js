// js/resource-renderers.js
//
// Purpose-built renderers for Cognita Resources.
//
// The backend produces structured educational content. This module turns
// that structure into actual educational interfaces instead of flattening
// everything into generic headings and lists.
//
// Current specialized renderers:
//   - flashcards
//   - quiz
//   - worksheet
//   - lesson_note
//
// Other resource types intentionally fall back to the existing generic
// renderer in resources.js until their dedicated renderers are implemented.

const ResourceRenderers = (() => {
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function normalizeText(value) {
    return String(value == null ? '' : value).trim();
  }

  function getCards(content) {
    return Array.isArray(content && content.cards) ? content.cards : [];
  }

  function getQuestions(content) {
    return Array.isArray(content && content.questions) ? content.questions : [];
  }

  function getSections(content) {
    return Array.isArray(content && content.sections) ? content.sections : [];
  }

  /*
   * ================================================================
   * FLASHCARDS
   * ================================================================
   */

  function renderFlashcards(content) {
    const cards = getCards(content);

    if (!cards.length) {
      return renderEmptyState(
        'No flashcards were generated.',
        'Try generating the resource again.'
      );
    }

    const safeTitle = escapeHtml(content.title || 'Flashcards');

    return `
      <div class="resource-specialized resource-flashcards" data-renderer="flashcards">

        <div class="resource-artifact-header flashcard-header">
          <div class="flashcard-header-text">
            <span class="resource-artifact-kicker">Study deck</span>
            <h3 class="resource-artifact-title">${safeTitle}</h3>
            <p class="resource-artifact-description">
              Tap the card to reveal the answer. Tap <strong>Present</strong> to show a card full screen to a class.
            </p>
          </div>

          <div class="flashcard-header-actions">
            <div class="resource-flashcard-progress" aria-live="polite">
              <span data-flashcard-current>1</span>
              <span class="resource-progress-divider">/</span>
              <span>${cards.length}</span>
            </div>

            <button
              type="button"
              class="flashcard-exit-present"
              data-flashcard-exit
              aria-label="Exit full screen"
            >
              <i class="ph ph-x"></i>
              <span>Exit</span>
            </button>
          </div>
        </div>

        <div class="flashcard-study-area">

          <button
            type="button"
            class="flashcard-nav flashcard-nav-prev"
            data-flashcard-prev
            aria-label="Previous flashcard"
          >
            <i class="ph ph-caret-left"></i>
            <span class="flashcard-nav-text">Previous</span>
          </button>

          <button
            type="button"
            class="flashcard"
            data-flashcard
            aria-label="Flashcard. Press to reveal the answer."
          >
            <span class="flashcard-inner">

              <span class="flashcard-face flashcard-front" data-flashcard-front-face>
                <span class="flashcard-face-label">QUESTION</span>
                <span class="flashcard-face-body">
                  <span class="flashcard-face-image" data-flashcard-image hidden></span>
                  <span class="flashcard-face-content" data-flashcard-front></span>
                </span>
                <span class="flashcard-hint">
                  <i class="ph ph-hand-tap"></i>
                  Tap to reveal
                </span>
              </span>

              <span class="flashcard-face flashcard-back" data-flashcard-back-face aria-hidden="true">
                <span class="flashcard-face-label">ANSWER</span>
                <span class="flashcard-face-body">
                  <span class="flashcard-face-content" data-flashcard-back></span>
                </span>
                <span class="flashcard-hint">
                  <i class="ph ph-arrow-counter-clockwise"></i>
                  Tap to flip back
                </span>
              </span>

            </span>
          </button>

          <button
            type="button"
            class="flashcard-nav flashcard-nav-next"
            data-flashcard-next
            aria-label="Next flashcard"
          >
            <span class="flashcard-nav-text">Next</span>
            <i class="ph ph-caret-right"></i>
          </button>

        </div>

        <div class="flashcard-progress-track" aria-hidden="true">
          <div class="flashcard-progress-fill" data-flashcard-progress></div>
        </div>

        <div class="flashcard-study-controls">

          <button
            type="button"
            class="flashcard-control flashcard-control-present"
            data-flashcard-present
          >
            <i class="ph ph-corners-out"></i>
            Present
          </button>

          <button
            type="button"
            class="flashcard-control flashcard-control-secondary"
            data-flashcard-shuffle
          >
            <i class="ph ph-shuffle"></i>
            Shuffle
          </button>

          <button
            type="button"
            class="flashcard-control flashcard-control-review"
            data-flashcard-review
          >
            <i class="ph ph-arrow-clockwise"></i>
            Review again
          </button>

          <button
            type="button"
            class="flashcard-control flashcard-control-known"
            data-flashcard-known
          >
            <i class="ph ph-check"></i>
            I know this
          </button>

          <button
            type="button"
            class="flashcard-control flashcard-control-secondary"
            data-flashcard-reset
          >
            <i class="ph ph-arrow-counter-clockwise"></i>
            Restart
          </button>

        </div>

        <div class="flashcard-status" data-flashcard-status aria-live="polite"></div>

        <div class="flashcard-keyboard-hint">
          <span><kbd>Space</kbd> Flip</span>
          <span><kbd>←</kbd> Previous</span>
          <span><kbd>→</kbd> Next</span>
          <span><kbd>Esc</kbd> Exit full screen</span>
        </div>

      </div>
    `;
  }

  // Only one deck can be shown full screen at a time. If the deck is redrawn
  // while presenting (e.g. new pictures arrived), the old full-screen copy
  // is cleaned up first so nothing is left stuck on top of the page.
  let activePresenter = null;

  function mountFlashcards(root, content) {
    if (activePresenter) activePresenter.exit();

    const sourceCards = getCards(content);

    if (!sourceCards.length) return;

    const deck = root.querySelector('.resource-flashcards');
    if (!deck) return;

    let cards = sourceCards.map((card, index) => ({
      id: index,
      front: normalizeText(card && card.front),
      back: normalizeText(card && card.back),
      imagePrompt: normalizeText(card && card.imagePrompt),
      image: card && card.image && (card.image.url || card.image.data) ? card.image : null,
      state: 'new',
    }));

    const originalCards = cards.map((card) => ({ ...card }));

    // When the deck is redrawn (for example after pictures finish arriving)
    // put the person back on the card they were looking at.
    const signature = originalCards.map((c) => c.front).join('\u0001');
    const saved = root.__flashcardState;
    let currentIndex = 0;
    if (saved && saved.signature === signature) {
      currentIndex = Math.min(Math.max(saved.cardId || 0, 0), cards.length - 1);
      cards.forEach((c) => { if (saved.states && saved.states[c.id]) c.state = saved.states[c.id]; });
    }
    let flipped = false;

    const cardElement = deck.querySelector('[data-flashcard]');
    const frontFace = deck.querySelector('[data-flashcard-front-face]');
    const backFace = deck.querySelector('[data-flashcard-back-face]');
    const frontElement = deck.querySelector('[data-flashcard-front]');
    const backElement = deck.querySelector('[data-flashcard-back]');
    const imageElement = deck.querySelector('[data-flashcard-image]');
    const currentElement = deck.querySelector('[data-flashcard-current]');
    const progressElement = deck.querySelector('[data-flashcard-progress]');
    const statusElement = deck.querySelector('[data-flashcard-status]');
    const prevButton = deck.querySelector('[data-flashcard-prev]');
    const nextButton = deck.querySelector('[data-flashcard-next]');
    const knownButton = deck.querySelector('[data-flashcard-known]');
    const reviewButton = deck.querySelector('[data-flashcard-review]');
    const shuffleButton = deck.querySelector('[data-flashcard-shuffle]');
    const resetButton = deck.querySelector('[data-flashcard-reset]');
    const presentButton = deck.querySelector('[data-flashcard-present]');
    const exitButton = deck.querySelector('[data-flashcard-exit]');

    function saveState() {
      const states = {};
      cards.forEach((c) => { if (c.state !== 'new') states[c.id] = c.state; });
      root.__flashcardState = {
        signature,
        cardId: cards[currentIndex] ? cards[currentIndex].id : 0,
        states,
      };
    }

    function renderImage(current) {
      imageElement.innerHTML = '';
      imageElement.classList.remove('is-loaded');

      const src = current.image
        ? (current.image.url ||
            (current.image.data
              ? 'data:' + (current.image.type || 'image/jpeg') + ';base64,' + current.image.data
              : ''))
        : '';

      if (!src) {
        imageElement.hidden = true;
        return;
      }

      imageElement.hidden = false;

      const img = document.createElement('img');
      img.alt = current.imagePrompt || 'Picture for this flashcard';
      img.decoding = 'async';
      img.draggable = false;
      img.addEventListener('load', () => imageElement.classList.add('is-loaded'));
      // If a picture can't be loaded (for example its link expired), hide
      // the empty frame instead of showing a broken-image icon. The
      // question and answer still work.
      img.addEventListener('error', () => {
        if (imageElement.contains(img)) {
          imageElement.innerHTML = '';
          imageElement.hidden = true;
        }
      });
      img.src = src;
      imageElement.appendChild(img);
    }

    // Quietly download the neighbouring pictures so flipping through the
    // deck is instant, even on a slow connection.
    function preloadNeighbours() {
      [cards[currentIndex + 1], cards[currentIndex - 1]].forEach((c) => {
        if (c && c.image && c.image.url) {
          const pre = new Image();
          pre.src = c.image.url;
        }
      });
    }

    function update() {
      const current = cards[currentIndex];

      if (!current) return;

      frontElement.textContent = current.front;
      backElement.textContent = current.back;
      currentElement.textContent = String(currentIndex + 1);

      renderImage(current);
      preloadNeighbours();

      const progress = ((currentIndex + 1) / cards.length) * 100;
      progressElement.style.width = `${progress}%`;

      cardElement.classList.toggle('is-flipped', flipped);
      cardElement.setAttribute(
        'aria-label',
        'Flashcard ' + (currentIndex + 1) + ' of ' + cards.length + '. ' +
          (flipped
            ? 'Answer: ' + current.back + '. Press to show the question.'
            : 'Question: ' + current.front + '. Press to reveal the answer.')
      );

      // Only the visible side should be read out by screen readers.
      frontFace.setAttribute('aria-hidden', flipped ? 'true' : 'false');
      backFace.setAttribute('aria-hidden', flipped ? 'false' : 'true');

      prevButton.disabled = currentIndex === 0;
      nextButton.disabled = currentIndex === cards.length - 1;

      knownButton.classList.toggle('is-selected', current.state === 'known');
      reviewButton.classList.toggle('is-selected', current.state === 'review');

      if (current.state === 'known') {
        statusElement.textContent = 'Marked as known.';
      } else if (current.state === 'review') {
        statusElement.textContent = 'Marked for review.';
      } else {
        statusElement.textContent = '';
      }

      saveState();
    }

    function flip() {
      flipped = !flipped;
      update();
    }

    function next() {
      if (currentIndex >= cards.length - 1) return;

      currentIndex += 1;
      flipped = false;
      update();
    }

    function previous() {
      if (currentIndex <= 0) return;

      currentIndex -= 1;
      flipped = false;
      update();
    }

    function markKnown() {
      cards[currentIndex].state = 'known';
      statusElement.textContent = 'Nice. This card is marked as known.';
      update();
    }

    function markReview() {
      cards[currentIndex].state = 'review';
      statusElement.textContent = 'Added to your review list.';
      update();
    }

    function shuffle() {
      for (let i = cards.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [cards[i], cards[j]] = [cards[j], cards[i]];
      }

      currentIndex = 0;
      flipped = false;
      update();
      statusElement.textContent = 'Deck shuffled.';
    }

    function reset() {
      cards = originalCards.map((card) => ({
        ...card,
        state: 'new',
      }));

      currentIndex = 0;
      flipped = false;
      update();
      statusElement.textContent = 'Deck restarted.';
    }

    /* ── Full-screen "Present" mode ──
       Lets a teacher hold up a phone/tablet or project the screen so the
       whole class can see the picture. Uses the browser's real full screen
       when it exists (desktop, Android, iPad) and a full-window overlay
       everywhere else (iPhone Safari has no element full screen). */
    let presenting = false;
    let placeholder = null;
    let usedFullscreen = false;
    let savedOverflow = null;

    function isFullscreenActive() {
      return !!(document.fullscreenElement || document.webkitFullscreenElement);
    }

    function onFullscreenChange() {
      // The person left real full screen (e.g. pressed Esc): leave the
      // overlay too.
      if (presenting && usedFullscreen && !isFullscreenActive()) exitPresent();
    }

    function enterPresent() {
      if (presenting) return;
      presenting = true;

      // Move the deck to <body> so no parent container can clip it or
      // limit its size.
      placeholder = document.createComment('flashcards-present');
      deck.parentNode.insertBefore(placeholder, deck);
      document.body.appendChild(deck);
      deck.classList.add('is-presenting');

      savedOverflow = {
        html: document.documentElement.style.overflow,
        body: document.body.style.overflow,
      };
      document.documentElement.style.overflow = 'hidden';
      document.body.style.overflow = 'hidden';

      document.addEventListener('keydown', onKey);
      document.addEventListener('fullscreenchange', onFullscreenChange);
      document.addEventListener('webkitfullscreenchange', onFullscreenChange);

      try {
        const request = deck.requestFullscreen || deck.webkitRequestFullscreen;
        if (request) {
          usedFullscreen = true;
          const result = request.call(deck);
          if (result && typeof result.catch === 'function') {
            result.catch(() => { usedFullscreen = false; });
          }
        }
      } catch (e) {
        usedFullscreen = false;
      }

      activePresenter = { exit: exitPresent };
      deck.focus({ preventScroll: true });
      update();
    }

    function exitPresent() {
      if (!presenting) return;
      presenting = false;

      document.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);

      if (usedFullscreen && isFullscreenActive()) {
        try {
          const leave = document.exitFullscreen || document.webkitExitFullscreen;
          const result = leave && leave.call(document);
          if (result && typeof result.catch === 'function') result.catch(() => {});
        } catch (e) {}
      }
      usedFullscreen = false;

      deck.classList.remove('is-presenting');

      if (savedOverflow) {
        document.documentElement.style.overflow = savedOverflow.html;
        document.body.style.overflow = savedOverflow.body;
        savedOverflow = null;
      }

      // Put the deck back where it came from. If the page was redrawn in
      // the meantime its old spot no longer exists, so just remove it.
      if (placeholder && placeholder.parentNode) {
        placeholder.parentNode.replaceChild(deck, placeholder);
      } else {
        deck.remove();
      }
      placeholder = null;

      if (activePresenter && activePresenter.exit === exitPresent) activePresenter = null;

      document.dispatchEvent(new CustomEvent('flashcards:present-exit'));
    }

    function onKey(event) {
      const target = event.target;

      // Never steal keys from text boxes (e.g. the follow-up instruction).
      if (target && target.closest && target.closest('input, textarea, select, [contenteditable="true"]')) {
        return;
      }

      if (event.key === 'Escape' && presenting) {
        event.preventDefault();
        exitPresent();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        next();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        previous();
      } else if (event.key === ' ' || event.code === 'Space') {
        // A focused button already flips/clicks itself on Space; handling
        // it here as well would flip twice.
        if (target && target.closest && target.closest('button')) return;
        event.preventDefault();
        flip();
      }
    }

    /* ── Touch: swipe left/right to move through the deck ── */
    let touchStart = null;
    let ignoreClickUntil = 0;

    cardElement.addEventListener('touchstart', (event) => {
      if (event.touches.length !== 1) {
        touchStart = null;
        return;
      }
      touchStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    }, { passive: true });

    cardElement.addEventListener('touchend', (event) => {
      if (!touchStart) return;
      const touch = event.changedTouches[0];
      const dx = touch.clientX - touchStart.x;
      const dy = touch.clientY - touchStart.y;
      touchStart = null;

      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        ignoreClickUntil = Date.now() + 400; // a swipe is not a tap
        if (dx < 0) next();
        else previous();
      }
    }, { passive: true });

    cardElement.addEventListener('click', () => {
      if (Date.now() < ignoreClickUntil) return;
      flip();
    });
    prevButton.addEventListener('click', previous);
    nextButton.addEventListener('click', next);
    knownButton.addEventListener('click', markKnown);
    reviewButton.addEventListener('click', markReview);
    shuffleButton.addEventListener('click', shuffle);
    resetButton.addEventListener('click', reset);
    presentButton.addEventListener('click', enterPresent);
    exitButton.addEventListener('click', exitPresent);

    // Attached to the deck itself (which is rebuilt on every draw), not to
    // the long-lived container — otherwise every redraw would add another
    // listener and one key press would move several cards.
    deck.addEventListener('keydown', (event) => {
      if (!presenting) onKey(event);
    });
    deck.setAttribute('tabindex', '0');

    update();
  }

  /*
   * ================================================================
   * QUIZ
   * ================================================================
   */

  function renderQuiz(content) {
    const questions = getQuestions(content);

    if (!questions.length) {
      return renderEmptyState(
        'No quiz questions were generated.',
        'Try generating the quiz again.'
      );
    }

    const safeTitle = escapeHtml(content.title || 'Quiz');

    return `
      <div class="resource-specialized resource-quiz" data-renderer="quiz">

        <div class="resource-artifact-header">
          <div>
            <span class="resource-artifact-kicker">Interactive quiz</span>
            <h3 class="resource-artifact-title">${safeTitle}</h3>
            <p class="resource-artifact-description">
              Choose the best answer, check your response, and continue through the quiz.
            </p>
          </div>

          <div class="quiz-score-badge" data-quiz-score>
            0 / 0
          </div>
        </div>

        <div class="quiz-progress">
          <div class="quiz-progress-label">
            <span>
              Question <strong data-quiz-current>1</strong> of ${questions.length}
            </span>
            <span data-quiz-percent>0%</span>
          </div>
          <div class="quiz-progress-track">
            <div class="quiz-progress-fill" data-quiz-progress></div>
          </div>
        </div>

        <div class="quiz-question-card">

          <div class="quiz-question-number" data-quiz-number>1</div>

          <div class="quiz-question-text" data-quiz-question></div>

          <div class="quiz-options" data-quiz-options></div>

          <div class="quiz-feedback" data-quiz-feedback hidden></div>

        </div>

        <div class="quiz-controls">
          <button
            type="button"
            class="quiz-control quiz-control-secondary"
            data-quiz-back
          >
            <i class="ph ph-arrow-left"></i>
            Back
          </button>

          <button
            type="button"
            class="quiz-control quiz-control-primary"
            data-quiz-check
          >
            Check answer
          </button>

          <button
            type="button"
            class="quiz-control quiz-control-primary"
            data-quiz-next
            hidden
          >
            Next question
            <i class="ph ph-arrow-right"></i>
          </button>
        </div>

        <div class="quiz-complete" data-quiz-complete hidden>
          <div class="quiz-complete-icon">
            <i class="ph ph-trophy"></i>
          </div>

          <span class="resource-artifact-kicker">Quiz complete</span>

          <h3 data-quiz-final-score>0 / 0</h3>

          <p data-quiz-final-message></p>

          <button
            type="button"
            class="quiz-control quiz-control-primary"
            data-quiz-retry
          >
            <i class="ph ph-arrow-counter-clockwise"></i>
            Try again
          </button>
        </div>

      </div>
    `;
  }

  function mountQuiz(root, content) {
    const questions = getQuestions(content);

    if (!questions.length) return;

    let currentIndex = 0;
    let selectedIndex = null;
    let checked = false;
    let score = 0;

    const questionNumber = root.querySelector('[data-quiz-number]');
    const questionText = root.querySelector('[data-quiz-question]');
    const optionsContainer = root.querySelector('[data-quiz-options]');
    const feedback = root.querySelector('[data-quiz-feedback]');
    const currentLabel = root.querySelector('[data-quiz-current]');
    const progress = root.querySelector('[data-quiz-progress]');
    const percent = root.querySelector('[data-quiz-percent]');
    const scoreBadge = root.querySelector('[data-quiz-score]');
    const backButton = root.querySelector('[data-quiz-back]');
    const checkButton = root.querySelector('[data-quiz-check]');
    const nextButton = root.querySelector('[data-quiz-next]');
    const completePanel = root.querySelector('[data-quiz-complete]');
    const finalScore = root.querySelector('[data-quiz-final-score]');
    const finalMessage = root.querySelector('[data-quiz-final-message]');
    const retryButton = root.querySelector('[data-quiz-retry]');
    const questionCard = root.querySelector('.quiz-question-card');

    function updateProgress() {
      const percentage = Math.round(
        ((currentIndex + 1) / questions.length) * 100
      );

      currentLabel.textContent = String(currentIndex + 1);
      percent.textContent = `${percentage}%`;
      progress.style.width = `${percentage}%`;
      scoreBadge.textContent = `${score} / ${questions.length}`;
    }

    function renderQuestion() {
      const question = questions[currentIndex];

      selectedIndex = null;
      checked = false;

      questionNumber.textContent = String(question.number || currentIndex + 1);
      questionText.textContent = question.question || '';

      optionsContainer.innerHTML = '';

      (question.options || []).forEach((option, index) => {
        const button = document.createElement('button');

        button.type = 'button';
        button.className = 'quiz-option';
        button.dataset.index = String(index);

        button.innerHTML = `
          <span class="quiz-option-letter">
            ${String.fromCharCode(65 + index)}
          </span>
          <span class="quiz-option-text"></span>
        `;

        button.querySelector('.quiz-option-text').textContent = option;

        button.addEventListener('click', () => {
          if (checked) return;

          selectedIndex = index;

          optionsContainer
            .querySelectorAll('.quiz-option')
            .forEach((item) => item.classList.remove('is-selected'));

          button.classList.add('is-selected');
        });

        optionsContainer.appendChild(button);
      });

      feedback.hidden = true;
      feedback.textContent = '';

      checkButton.hidden = false;
      nextButton.hidden = true;

      backButton.disabled = currentIndex === 0;

      updateProgress();
    }

    function checkAnswer() {
      if (selectedIndex === null) {
        feedback.hidden = false;
        feedback.className = 'quiz-feedback is-warning';
        feedback.innerHTML = `
          <i class="ph ph-info"></i>
          <span>Please choose an answer first.</span>
        `;
        return;
      }

      if (checked) return;

      checked = true;

      const question = questions[currentIndex];
      const correctIndex = Number(question.correctOptionIndex);

      const options = optionsContainer.querySelectorAll('.quiz-option');

      options.forEach((option, index) => {
        option.disabled = true;

        if (index === correctIndex) {
          option.classList.add('is-correct');
        }

        if (index === selectedIndex && index !== correctIndex) {
          option.classList.add('is-incorrect');
        }
      });

      const isCorrect = selectedIndex === correctIndex;

      if (isCorrect) {
        score += 1;

        feedback.hidden = false;
        feedback.className = 'quiz-feedback is-correct';
        feedback.innerHTML = `
          <i class="ph ph-check-circle"></i>
          <span>Correct. Great job.</span>
        `;
      } else {
        feedback.hidden = false;
        feedback.className = 'quiz-feedback is-incorrect';

        const correctAnswer =
          question.options && question.options[correctIndex]
            ? question.options[correctIndex]
            : 'the highlighted answer';

        feedback.innerHTML = `
          <i class="ph ph-x-circle"></i>
          <span>
            Not quite. The correct answer is
            <strong>${escapeHtml(correctAnswer)}</strong>.
          </span>
        `;
      }

      checkButton.hidden = true;
      nextButton.hidden = false;

      updateProgress();
    }

    function next() {
      if (!checked) return;

      if (currentIndex >= questions.length - 1) {
        finish();
        return;
      }

      currentIndex += 1;
      renderQuestion();
    }

    function previous() {
      if (currentIndex <= 0) return;

      currentIndex -= 1;
      renderQuestion();
    }

    function finish() {
      questionCard.hidden = true;
      completePanel.hidden = false;

      finalScore.textContent = `${score} / ${questions.length}`;

      const percentage = Math.round((score / questions.length) * 100);

      if (percentage === 100) {
        finalMessage.textContent =
          'Perfect score. You have mastered this quiz.';
      } else if (percentage >= 80) {
        finalMessage.textContent =
          'Excellent work. You have a strong understanding of this topic.';
      } else if (percentage >= 60) {
        finalMessage.textContent =
          'Good work. Review the questions you missed and try again.';
      } else {
        finalMessage.textContent =
          'Keep going. Review the topic and try the quiz again.';
      }
    }

    function retry() {
      currentIndex = 0;
      selectedIndex = null;
      checked = false;
      score = 0;

      questionCard.hidden = false;
      completePanel.hidden = true;

      renderQuestion();
    }

    checkButton.addEventListener('click', checkAnswer);
    nextButton.addEventListener('click', next);
    backButton.addEventListener('click', previous);
    retryButton.addEventListener('click', retry);

    renderQuestion();
  }

  /*
   * ================================================================
   * WORKSHEET
   * ================================================================
   */

  function renderWorksheet(content) {
    const questions = getQuestions(content);

    if (!questions.length) {
      return renderEmptyState(
        'No worksheet questions were generated.',
        'Try generating the worksheet again.'
      );
    }

    const safeTitle = escapeHtml(content.title || 'Worksheet');

    const questionsHtml = questions
      .map((question, index) => {
        const type = normalizeText(question.type || 'short answer');
        const options = Array.isArray(question.options) ? question.options : [];
        const showOptions = type === 'multiple_choice' && options.length > 0;

        const optionsHtml = showOptions
          ? `
            <div class="worksheet-question-options">
              ${options
                .map(
                  (option, optIndex) => `
                    <div class="worksheet-question-option">
                      <span class="worksheet-question-option-letter">${escapeHtml(String.fromCharCode(65 + optIndex))}</span>
                      <span>${escapeHtml(option)}</span>
                    </div>
                  `
                )
                .join('')}
            </div>
          `
          : '';

        return `
          <article class="worksheet-question">
            <div class="worksheet-question-number">
              ${escapeHtml(question.number || index + 1)}
            </div>

            <div class="worksheet-question-main">
              <div class="worksheet-question-type">
                ${escapeHtml(type)}
              </div>

              <div class="worksheet-question-text">
                ${escapeHtml(question.question || '')}
              </div>

              ${optionsHtml}

              ${showOptions ? '' : `
                <div class="worksheet-answer-lines">
                  <div></div>
                  <div></div>
                  <div></div>
                </div>
              `}
            </div>
          </article>
        `;
      })
      .join('');

    const answerKey = Array.isArray(content.answerKey)
      ? content.answerKey
      : [];

    const answerKeyHtml = answerKey.length
      ? `
        <section class="worksheet-answer-key">
          <div class="worksheet-answer-key-header">
            <span class="resource-artifact-kicker">Teacher answer key</span>
            <h4>Answers</h4>
          </div>

          <div class="worksheet-answer-grid">
            ${answerKey
              .map(
                (answer) => `
                  <div class="worksheet-answer-item">
                    <strong>${escapeHtml(answer.number)}</strong>
                    <span>${escapeHtml(answer.answer)}</span>
                  </div>
                `
              )
              .join('')}
          </div>
        </section>
      `
      : '';

    return `
      <div class="resource-specialized resource-worksheet" data-renderer="worksheet">

        <header class="worksheet-header">
          <div class="worksheet-brand">COGNITA</div>

          <div class="worksheet-title-block">
            <span class="resource-artifact-kicker">Student worksheet</span>
            <h3>${safeTitle}</h3>
          </div>

          <div class="worksheet-student-fields">
            <div>
              <span>Name</span>
              <div></div>
            </div>

            <div>
              <span>Class</span>
              <div></div>
            </div>

            <div>
              <span>Date</span>
              <div></div>
            </div>
          </div>
        </header>

        <div class="worksheet-instructions">
          <strong>Instructions</strong>
          <p>${escapeHtml(content.instructions || 'Answer all questions.')}</p>
        </div>

        <div class="worksheet-questions">
          ${questionsHtml}
        </div>

        ${answerKeyHtml}

      </div>
    `;
  }

  /*
   * ================================================================
   * LESSON NOTE
   * ================================================================
   * A calm, textbook-like reading surface — no interactivity, no cards
   * per fact, no raw JSON keys. Section "type" drives how content
   * renders (paragraph / bullets / numbered / definition / example /
   * formula) but is never shown to the reader.
   */

  function renderLessonNoteSection(section) {
    const heading = `<h4 class="lesson-note-heading">${escapeHtml(section.heading)}</h4>`;
    const content = section.content;

    switch (section.type) {
      case 'bullets':
        return heading + '<ul class="lesson-note-bullets">' +
          (Array.isArray(content) ? content : []).map((item) => `<li>${escapeHtml(item)}</li>`).join('') +
          '</ul>';

      case 'numbered':
        return heading + '<ol class="lesson-note-numbered">' +
          (Array.isArray(content) ? content : []).map((item) => `<li>${escapeHtml(item)}</li>`).join('') +
          '</ol>';

      case 'definition':
        return heading + '<dl class="lesson-note-definitions">' +
          (Array.isArray(content) ? content : [])
            .map((entry) => `<div class="lesson-note-definition"><dt>${escapeHtml(entry.term)}</dt><dd>${escapeHtml(entry.explanation)}</dd></div>`)
            .join('') +
          '</dl>';

      case 'example':
        return heading +
          `<div class="lesson-note-example"><span class="lesson-note-example-label">Example</span><p>${escapeHtml(content)}</p></div>`;

      case 'formula':
        return heading +
          `<div class="lesson-note-formula">${escapeHtml(content)}</div>`;

      case 'paragraph':
      default:
        return heading + `<p class="lesson-note-paragraph">${escapeHtml(content)}</p>`;
    }
  }

  function renderLessonNote(content) {
    const sections = getSections(content);

    if (!sections.length) {
      return renderEmptyState(
        'No lesson note content was generated.',
        'Try generating the resource again.'
      );
    }

    const safeTitle = escapeHtml(content.title || 'Lesson Note');

    return `
      <div class="resource-specialized resource-lesson-note" data-renderer="lesson_note">

        <div class="lesson-note-page">
          <span class="resource-artifact-kicker">Lesson note</span>
          <h3 class="lesson-note-title">${safeTitle}</h3>

          ${content.introduction ? `<p class="lesson-note-intro">${escapeHtml(content.introduction)}</p>` : ''}

          <div class="lesson-note-body">
            ${sections.map(renderLessonNoteSection).join('')}
          </div>

          ${content.summary ? `
            <div class="lesson-note-summary">
              <span class="lesson-note-summary-label">Summary</span>
              <p>${escapeHtml(content.summary)}</p>
            </div>
          ` : ''}
        </div>

      </div>
    `;
  }

  /*
   * ================================================================
   * FALLBACK
   * ================================================================
   */

  function renderEmptyState(title, description) {
    return `
      <div class="resource-empty-state">
        <div class="resource-empty-state-icon">
          <i class="ph ph-file-dashed"></i>
        </div>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(description)}</p>
      </div>
    `;
  }

  function render(resourceType, content) {
    switch (resourceType) {
      case 'flashcards':
        return renderFlashcards(content);

      case 'quiz':
        return renderQuiz(content);

      case 'worksheet':
        return renderWorksheet(content);

      case 'lesson_note':
        return renderLessonNote(content);

      default:
        return null;
    }
  }

  function mount(resourceType, root, content) {
    if (!root) return;

    // Flashcards manage their own size (the page, not a small scrolling
    // box, does the scrolling), so the container drops its height cap.
    root.classList.toggle('is-flashcard-view', resourceType === 'flashcards');

    switch (resourceType) {
      case 'flashcards':
        mountFlashcards(root, content);
        break;

      case 'quiz':
        mountQuiz(root, content);
        break;

      default:
        break;
    }
  }

  return {
    render,
    mount,
  };
})();

window.ResourceRenderers = ResourceRenderers;
