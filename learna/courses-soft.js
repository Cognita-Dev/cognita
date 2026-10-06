// learna/courses-soft.js
// Public Speaking, UI/UX Design and Sales courses. Open tasks are marked against
// the rubric on each activity; choice and match items are checked exactly.
import { teach, activity as act, lesson, section } from './courses-core.js';

const common = { access: 'plus', status: 'available', version: '1.0.0', masteryThreshold: 0.7, levelSystem: 'Beginner / Intermediate / Advanced' };

export const speaking = {
  ...common,
  id: 'public-speaking-essentials', title: 'Public Speaking Essentials',
  shortDescription: 'Open strongly, structure a short talk and sound clear under pressure.',
  fullDescription: 'Build the habits of a clear speaker. You write and rehearse real openings, short talks and introductions, then get feedback against a rubric that names exactly what to fix.',
  category: 'public-speaking', level: 'Beginner', estimatedDuration: '1 hour 30 minutes', estimatedMinutes: 90,
  whoFor: 'Students and professionals who want to speak with more clarity and less stress.',
  prerequisites: ['None'],
  learningOutcomes: ['Open a talk in under 20 seconds', 'Organise a short talk in three parts', 'Introduce yourself at a networking event', 'Use pauses and short sentences'],
  skills: ['Openings', 'Structure', 'Self-introduction', 'Clear delivery'],
  practical: 'Each lesson ends with a written script or a rehearsal task you can say aloud in under a minute.',
  assessment: 'Questions are checked exactly. Written scripts are marked against a rubric of named criteria. A lesson is complete when you pass at least 70% of its activities without being shown the answer.',
  modes: ['writing', 'rehearsal'], references: [],
  sections: [section('s1', 'Start well', 'Openings and introductions.', [
    lesson('l1', 'Opening a talk', 'By the end of this lesson, you can open a talk with a hook that names the topic in under 20 seconds.', 15, [
      teach('t1', 'explanation', 'The first 20 seconds', [
        'Your audience decides quickly whether to listen. A strong opening does two things: it gives them a reason to care, and it tells them what the talk is about.',
        'Three simple openings work well: a surprising fact, a short question, or a one-sentence story. Avoid starting with an apology ("Sorry, I am not very good at this") or with "Today I will be talking about".',
      ], { label: 'Example', text: 'Every year, our school loses about 40 hours of teaching time to paper registers. Today I will show you how to get those hours back.' }),
      act('a1', 'guided', 'Spot the weak opening', {
        type: 'choice', prompt: 'Which opening is weakest?',
        options: [{ id: 'a', text: 'Sorry, I am a bit nervous, so please bear with me.' }, { id: 'b', text: 'How many hours did you waste in meetings this week?' }, { id: 'c', text: 'Last month a customer called me at midnight, and she was right to.' }],
        answer: 'a', why: { b: 'A question makes the audience think about their own experience.', c: 'A short story creates curiosity.' },
        hints: ['One opening gives the audience a reason to doubt you.'], explain: 'An apology makes people watch for mistakes instead of listening.',
      }),
      act('a2', 'attempt', 'Write your opening', {
        type: 'open', mode: 'writing',
        prompt: 'Write an opening of two or three sentences for a 3-minute talk to your class about why people should sleep eight hours. Use a surprising fact, a question or a short story. Do not apologise.',
        minWords: 15, minCriteria: 2,
        rubric: [
          { id: 'hook', label: 'Begins with a hook: a fact, a question or a short story.' },
          { id: 'topic', label: 'Makes clear that the talk is about sleep.' },
          { id: 'noapology', label: 'Contains no apology and does not begin with "Today I will be talking about".' },
        ],
        hints: ['Try starting with a question about the last time they felt tired.'],
        exemplar: 'When did you last wake up feeling truly rested? Most of us cannot remember, and it is costing our marks. In the next three minutes, I will show you why eight hours matters.',
        explain: 'A hook first, then the topic, with no apology.',
      }),
      act('a3', 'checkpoint', 'Choose the stronger opening', {
        type: 'choice', prompt: 'You will speak about saving money. Which opening is strongest?',
        options: [{ id: 'a', text: 'Today I will be talking about saving money.' }, { id: 'b', text: 'If you saved just \u20a65,000 a month, you would have \u20a660,000 in a year. Here is how.' }, { id: 'c', text: 'Um, so, hi everyone, I guess I will start now.' }],
        answer: 'b', why: { a: 'It names the topic but gives no reason to care.', c: 'Filler words and hesitation weaken the opening.' }, hints: ['Look for a specific number and a promise.'], explain: 'It gives a concrete benefit and promises how.',
      }),
    ]),
    lesson('l2', 'Introducing yourself', 'By the end of this lesson, you can give a 60-second introduction for a networking event.', 20, [
      teach('t1', 'explanation', 'Name, what you do, why talk to me', [
        'A good introduction has three parts. First, your name and role. Second, what you do in one plain sentence. Third, one reason the listener should continue the conversation.',
        'Keep sentences short. Say the name slowly. Finish with an invitation, such as a question.',
      ], { label: 'Example', text: 'I am Ngozi Eze, a maths teacher at a primary school in Yaba. I help children who fear numbers start enjoying them. If you know a child who struggles with maths, I would love to hear what they find hard.' }),
      act('b1', 'guided', 'Order the parts', {
        type: 'order', prompt: 'Put the three parts of an introduction in the best order.',
        items: ['My name and role', 'What I do in one sentence', 'A reason to keep talking'],
        hints: ['Who you are comes first.'], explain: 'Name and role, what you do, then the reason to talk.',
      }),
      act('b2', 'checkpoint', 'Write your 60-second introduction', {
        type: 'open', mode: 'writing',
        prompt: 'Write a 60-second introduction for a professional networking event. Start with your name and role, explain what you do in one sentence, then give one reason someone should continue the conversation with you.',
        minWords: 25, minCriteria: 3,
        rubric: [
          { id: 'name', label: 'States a name and a role at the start.' },
          { id: 'what', label: 'Explains what the person does in one clear sentence.' },
          { id: 'reason', label: 'Gives one reason or invitation to continue the conversation.' },
        ],
        hints: ['Three parts, in this order. Keep each to one or two short sentences.'],
        exemplar: 'I am Daniel Okoro, a product designer at a fintech startup. I design apps that make saving money feel simple. If you ever wondered why banking apps are confusing, I would enjoy swapping stories.',
        explain: 'Follow the three-part order and keep it short.',
      }),
    ]),
  ])],
};

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
    ]),
  ])],
};
