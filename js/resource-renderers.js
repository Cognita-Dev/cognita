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

        <div class="resource-artifact-header">
          <div>
            <span class="resource-artifact-kicker">Study deck</span>
            <h3 class="resource-artifact-title">${safeTitle}</h3>
            <p class="resource-artifact-description">
              Tap the card to reveal the answer. Use the controls below to move through the deck.
            </p>
          </div>

          <div class="resource-flashcard-progress" aria-live="polite">
            <span data-flashcard-current>1</span>
            <span class="resource-progress-divider">/</span>
            <span>${cards.length}</span>
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
          </button>

          <button
            type="button"
            class="flashcard"
            data-flashcard
            aria-label="Flashcard. Click to reveal the answer."
          >
            <span class="flashcard-inner">

              <span class="flashcard-face flashcard-front">
                <span class="flashcard-face-label">QUESTION</span>
                <span class="flashcard-face-image" data-flashcard-image hidden></span>
                <span class="flashcard-face-content" data-flashcard-front></span>
                <span class="flashcard-hint">
                  <i class="ph ph-hand-tap"></i>
                  Tap to reveal
                </span>
              </span>

              <span class="flashcard-face flashcard-back">
                <span class="flashcard-face-label">ANSWER</span>
                <span class="flashcard-face-content" data-flashcard-back></span>
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
            <i class="ph ph-caret-right"></i>
          </button>

        </div>

        <div class="flashcard-progress-track" aria-hidden="true">
          <div class="flashcard-progress-fill" data-flashcard-progress></div>
        </div>

        <div class="flashcard-study-controls">

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
        </div>

      </div>
    `;
  }

  function mountFlashcards(root, content) {
    const sourceCards = getCards(content);

    if (!sourceCards.length) return;

    let cards = sourceCards.map((card, index) => ({
      id: index,
      front: normalizeText(card.front),
      back: normalizeText(card.back),
      image: card && card.image && card.image.data ? card.image : null,
      state: 'new',
    }));

    const originalCards = cards.map((card) => ({ ...card }));

    let currentIndex = 0;
    let flipped = false;

    const cardElement = root.querySelector('[data-flashcard]');
    const frontElement = root.querySelector('[data-flashcard-front]');
    const backElement = root.querySelector('[data-flashcard-back]');
    const imageElement = root.querySelector('[data-flashcard-image]');
    const currentElement = root.querySelector('[data-flashcard-current]');
    const progressElement = root.querySelector('[data-flashcard-progress]');
    const statusElement = root.querySelector('[data-flashcard-status]');
    const prevButton = root.querySelector('[data-flashcard-prev]');
    const nextButton = root.querySelector('[data-flashcard-next]');
    const knownButton = root.querySelector('[data-flashcard-known]');
    const reviewButton = root.querySelector('[data-flashcard-review]');
    const shuffleButton = root.querySelector('[data-flashcard-shuffle]');
    const resetButton = root.querySelector('[data-flashcard-reset]');

    function update() {
      const current = cards[currentIndex];

      if (!current) return;

      frontElement.textContent = current.front;
      backElement.textContent = current.back;
      currentElement.textContent = String(currentIndex + 1);

      if (imageElement) {
        if (current.image) {
          imageElement.hidden = false;
          imageElement.innerHTML =
            '<img src="data:' + escapeHtml(current.image.type || 'image/jpeg') +
            ';base64,' + current.image.data + '" alt="" loading="lazy">';
        } else {
          imageElement.hidden = true;
          imageElement.innerHTML = '';
        }
      }

      const progress = ((currentIndex + 1) / cards.length) * 100;
      progressElement.style.width = `${progress}%`;

      cardElement.classList.toggle('is-flipped', flipped);

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
      statusElement.textContent = 'Deck shuffled.';
      update();
    }

    function reset() {
      cards = originalCards.map((card) => ({
        ...card,
        state: 'new',
      }));

      currentIndex = 0;
      flipped = false;
      statusElement.textContent = 'Deck restarted.';
      update();
    }

    cardElement.addEventListener('click', flip);
    prevButton.addEventListener('click', previous);
    nextButton.addEventListener('click', next);
    knownButton.addEventListener('click', markKnown);
    reviewButton.addEventListener('click', markReview);
    shuffleButton.addEventListener('click', shuffle);
    resetButton.addEventListener('click', reset);

    root.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        next();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        previous();
      } else if (event.key === ' ' || event.code === 'Space') {
        event.preventDefault();
        flip();
      }
    });

    root.setAttribute('tabindex', '0');

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
