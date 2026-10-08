// learna/courses-soft.js
// UI/UX Design and Sales courses (Public Speaking now lives in courses-speaking.js). Open tasks are marked against
// the rubric on each activity; choice and match items are checked exactly.
import { teach, activity as act, lesson, section, assignment } from './courses-core.js';

const common = { access: 'plus', status: 'available', version: '1.0.0', masteryThreshold: 0.7, levelSystem: 'Beginner / Intermediate / Advanced' };

export const uiux = {
  ...common,
  id: 'ui-ux-foundations', title: 'UI/UX Design Foundations',
  shortDescription: 'Understand users, define a problem and design a clear screen with a reason for every choice.',
  fullDescription: 'Learn how designers move from a user problem to a clear screen. You work through real design briefs with a named user, a context and constraints, and are judged on the reasoning behind your choices.',
  category: 'ui-ux', level: 'Beginner', estimatedDuration: '1 hour 30 minutes', estimatedMinutes: 90,
  whoFor: 'Beginners who want to understand how good interfaces are designed.',
  prerequisites: ['None. You do not need design software.'],
  learningOutcomes: ['Describe a user and a problem in one sentence', 'Apply visual hierarchy to a screen', 'Write clear button and error text', 'Justify a design choice with the user\u2019s goal'],
  skills: ['User needs', 'Problem statements', 'Visual hierarchy', 'Interface copy'],
  practical: 'Each lesson gives a design brief with a user, context, constraints and a deliverable you write in words.',
  assessment: 'Questions are checked exactly. Design responses are marked against a rubric of named criteria. A lesson is complete when you pass at least 70% of its activities without being shown the answer.',
  modes: ['writing', 'critique'], references: [],
  sections: [section('s1', 'Think like a designer', 'Start from the person, not the screen.', [
    lesson('l1', 'The problem statement', 'By the end of this lesson, you can write a one-sentence problem statement that names a user, a need and the reason.', 20, [
      teach('t1', 'explanation', 'User, need, reason', [
        'A problem statement keeps a design focused. Use this pattern: [User] needs a way to [do something] because [reason].',
        'It describes the problem, not the solution. "Users need a bigger button" is a solution. "Parents need to pay school fees from their phone because they cannot visit the office during work hours" is a problem.',
      ], { label: 'Example', text: 'Market traders need a way to record daily sales in under a minute because they are serving customers all day.' }),
      act('a1', 'guided', 'Problem or solution?', {
        type: 'choice', prompt: 'Which one is a problem statement, not a solution?',
        options: [{ id: 'a', text: 'Add a chatbot to the homepage.' }, { id: 'b', text: 'Nurses need a way to find a patient\u2019s allergies quickly because delays can be dangerous.' }, { id: 'c', text: 'Make the logo larger.' }],
        answer: 'b', why: { a: 'This is a feature.', c: 'This is a visual change.' }, hints: ['Look for a user, a need and a reason.'], explain: 'It names the user, the need and the reason.',
      }),
      act('a2', 'checkpoint', 'Write a problem statement', {
        type: 'open', mode: 'writing',
        prompt: 'Brief: A secondary school wants parents to know their child\u2019s attendance without visiting the school. User: a parent who works long hours. Constraint: many parents use low-cost Android phones with limited data. Write one problem statement using the pattern: [User] needs a way to [do something] because [reason].',
        minWords: 15, minCriteria: 3,
        rubric: [
          { id: 'user', label: 'Names a specific user such as a working parent.' },
          { id: 'need', label: 'States a need related to checking attendance, not a solution or feature.' },
          { id: 'reason', label: 'Gives a reason with because.' },
        ],
        hints: ['Do not write "build an app". Describe what the parent needs to do.'],
        exemplar: 'Working parents need a way to check their child\u2019s attendance without visiting the school because they cannot leave work during school hours.',
        explain: 'User, need, reason, with no solution.',
      }),
    ]),
    lesson('l2', 'Visual hierarchy and interface text', 'By the end of this lesson, you can choose what is most important on a screen and write a clear button label.', 20, [
      teach('t1', 'explanation', 'Show the main thing first', [
        'Visual hierarchy tells the eye where to look first. You create it with size, weight, colour and space. One screen should have one main action.',
        'Button text should say what happens: "Pay \u20a612,000" is clearer than "Submit". Error messages should say what went wrong and how to fix it.',
      ], { label: 'Example', text: 'Weak error: "Invalid input."\nClear error: "Your phone number needs 11 digits. Check it and try again."' }),
      act('b1', 'guided', 'Choose the clearest button', {
        type: 'choice', prompt: 'A parent is about to pay school fees. Which button label is clearest?',
        options: [{ id: 'a', text: 'Submit' }, { id: 'b', text: 'Pay \u20a612,000' }, { id: 'c', text: 'OK' }],
        answer: 'b', why: { a: 'Submit does not say what will happen.', c: 'OK is vague.' }, hints: ['The label should say what happens and how much.'], explain: 'It names the action and the amount.',
      }),
      act('b2', 'checkpoint', 'Rewrite the error', {
        type: 'open', mode: 'writing',
        prompt: 'A form shows this error when someone enters a password with 5 characters: "Error 422." Rewrite it as a clear message for a first-time user. The password must have at least 8 characters.',
        minWords: 8, minCriteria: 2,
        rubric: [
          { id: 'what', label: 'Says what is wrong in plain words (the password is too short).' },
          { id: 'fix', label: 'Tells the user what to do, including the 8 character minimum.' },
          { id: 'tone', label: 'Does not blame the user or use technical codes.' },
        ],
        hints: ['Say what is wrong, then how to fix it.'],
        exemplar: 'Your password is too short. Use at least 8 characters and try again.',
        explain: 'Name the problem and the fix in plain words.',
      }),
      act('b3', 'reflection', 'Explain your choice aloud', {
        type: 'open', mode: 'writing', voice: true, minWords: 15, minCriteria: 2,
        prompt: 'Explain one design decision you would make on a sign-up screen and why. Say it aloud with the microphone button, or type it. Designers often explain choices out loud to a team.',
        rubric: [{ id: 'decision', label: 'States one specific design decision.' }, { id: 'user', label: 'Links it to what the user needs.' }, { id: 'reason', label: 'Gives a reason.' }],
        hints: ['Name the decision, then say who it helps.'],
        exemplar: 'I would put the sign-up button at the bottom in a bright colour because a new user needs one clear next step. A single obvious button means fewer people get lost.',
        explain: 'Decision, user need, reason.',
      }),
    ]),
  ])],
};

export const sales = {
  ...common,
  id: 'sales-conversations', title: 'Sales Conversations',
  shortDescription: 'Ask better questions, handle first objections and close with a clear next step.',
  fullDescription: 'Practise the conversations that win business. Each task puts you in a specific situation, such as selling a software subscription to a small school, and marks your response against clear criteria.',
  category: 'sales-marketing', level: 'Beginner', estimatedDuration: '1 hour 30 minutes', estimatedMinutes: 90,
  whoFor: 'Small business owners, new sales staff and anyone who has to persuade customers.',
  prerequisites: ['None'],
  learningOutcomes: ['Ask discovery questions before pitching', 'Respond to a first objection without discounting', 'Ask for a clear next step'],
  skills: ['Discovery', 'Objection handling', 'Next steps'],
  practical: 'Each lesson has a role-play where you write exactly what you would say.',
  assessment: 'Questions are checked exactly. Role-play responses are marked against a rubric of named criteria. A lesson is complete when you pass at least 70% of its activities without being shown the answer.',
  modes: ['role-play', 'writing'], references: [],
  sections: [section('s1', 'Talk to the customer', 'Discovery and objections.', [
    lesson('l1', 'Discovery questions', 'By the end of this lesson, you can ask an open question that uncovers what the customer uses today and what it costs them.', 15, [
      teach('t1', 'explanation', 'Ask before you pitch', [
        'Customers buy when they see the cost of their current problem. You find it by asking. Open questions start with what, how or tell me about. They cannot be answered with yes or no.',
        'A good discovery question is specific to the customer\u2019s work, and it is followed by listening.',
      ], { label: 'Example', text: 'Closed: "Do you have problems with records?"\nOpen: "How do you keep track of student records today, and what happens when one goes missing?"' }),
      act('a1', 'guided', 'Spot the open question', {
        type: 'choice', prompt: 'Which is an open discovery question?',
        options: [{ id: 'a', text: 'Do you like spreadsheets?' }, { id: 'b', text: 'How do you collect fees at the start of each term?' }, { id: 'c', text: 'Do you want to buy today?' }],
        answer: 'b', why: { a: 'This can be answered with yes or no.', c: 'This is a closing question, not discovery.' }, hints: ['Open questions often start with how or what.'], explain: 'It invites a full answer about their process.',
      }),
      act('a2', 'checkpoint', 'Write a discovery question', {
        type: 'open', mode: 'writing',
        prompt: 'You sell a school management app. The head teacher says, "We already use WhatsApp and spreadsheets." Write one open discovery question that asks how they manage something specific, such as fee records or attendance.',
        minWords: 8, minCriteria: 2,
        rubric: [
          { id: 'open', label: 'The question is open and starts with how, what or tell me about, not do you.' },
          { id: 'specific', label: 'It refers to a specific task such as fees, attendance or records.' },
          { id: 'nopitch', label: 'It does not pitch the product or offer a discount.' },
        ],
        hints: ['Do not defend the app. Ask about their current process.'],
        exemplar: 'How do you keep track of which parents have paid fees each term, and how long does it take you to check?',
        explain: 'Open, specific, and no pitch.',
      }),
    ]),
    lesson('l2', 'Handling the first objection', 'By the end of this lesson, you can respond to a customer\u2019s first objection without immediately discounting the product.', 20, [
      teach('t1', 'explanation', 'Acknowledge, find the value, ask', [
        'An objection is information. A strong response has three steps. First, acknowledge the concern so the customer feels heard. Second, identify the value they may be missing. Third, ask one discovery question.',
        'Offering a discount first teaches the customer that your price is not firm and does not address the real concern.',
      ], { label: 'Example', text: '"That makes sense, many schools start with WhatsApp. The risk is when a record is buried in a long chat. How do you find last term\u2019s results today?"' }),
      act('b1', 'guided', 'Put the response in order', {
        type: 'order', prompt: 'Put the three steps of handling an objection in the right order.',
        items: ['Acknowledge the concern', 'Point to the missing value', 'Ask one discovery question'],
        hints: ['Make the customer feel heard first.'], explain: 'Acknowledge, show value, then ask.',
      }),
      act('b2', 'checkpoint', 'Respond in three sentences', {
        type: 'open', mode: 'writing',
        prompt: 'Imagine you are selling a \u20a6250,000 annual software subscription to a small school. The school says, "We already use WhatsApp and spreadsheets." Respond in three sentences: acknowledge the concern, identify the missing value, and ask one discovery question.',
        minWords: 25, minCriteria: 3,
        rubric: [
          { id: 'ack', label: 'Acknowledges the concern without arguing.' },
          { id: 'value', label: 'Identifies a specific value the current tools miss, such as finding records or tracking payments.' },
          { id: 'ask', label: 'Ends with one discovery question.' },
          { id: 'nodiscount', label: 'Does not offer a discount.' },
        ],
        hints: ['Sentence one acknowledges. Sentence two names the missing value. Sentence three is a question.'],
        exemplar: 'That makes sense, because many schools begin with WhatsApp and spreadsheets. The difficulty is that a payment or a result can be hard to find when it is buried in a long chat. How do you check today which parents have not paid?',
        explain: 'Three sentences: acknowledge, show the gap, ask.',
      }),
      assignment('b3', 'independent', 'Practise your pitch aloud', {
        format: 'audio', review: 'auto', certRequired: false, minSeconds: 20, maxSeconds: 90, maxAttempts: 3,
        prompt: 'Imagine a school owner says: "We already use WhatsApp and spreadsheets." Record a 20 to 45 second reply that acknowledges the point, shows the gap and asks one question.',
        rubric: [{ id: 'ack', label: 'Acknowledges what the customer said.' }, { id: 'gap', label: 'Shows one gap or cost in the current way.' }, { id: 'ask', label: 'Ends with one open question.' }],
        metricRules: [], checklist: ['Stay calm', 'Do not argue', 'End with a question'],
      }),
    ]),
  ])],
};
