// learna/courses-french.js
import { teach, activity as act, lesson, section } from './courses-core.js';

export const french = {
  id: 'french-a1',
  title: 'French for Beginners (A1)',
  shortDescription: 'Introduce yourself, order a drink and ask for directions in simple, correct French.',
  fullDescription: 'This course takes you from no French to the first steps of A1. Every lesson ends with something you can say or write in a real situation: meeting someone, saying where you are from, ordering at a café and asking the way. Explanations are in English. The French is checked against the course material, not invented on the spot.',
  category: 'languages',
  level: 'A1',
  levelSystem: 'CEFR-inspired',
  estimatedDuration: '2 hours',
  estimatedMinutes: 120,
  whoFor: 'Adults and teenagers who have never studied French, or who want to restart from the beginning.',
  prerequisites: ['None. You only need to read English.'],
  learningOutcomes: [
    'Greet people and introduce yourself',
    'Say where you are from and ask the same question',
    'Order a drink or a snack politely',
    'Ask where a place is and understand simple directions',
  ],
  skills: ['Greetings', 'Introductions', 'The verb être', 'Polite requests', 'Directions'],
  practical: 'Each section ends with a short speaking-or-writing task set in a real situation.',
  assessment: 'Exact-answer exercises are checked by the course. Short writing tasks are marked against a rubric. A lesson is complete when you answer at least 70% of its activities without being shown the answer.',
  modes: ['reading', 'writing', 'vocabulary', 'grammar', 'communication'],
  language: { explanation: 'English', target: 'French', framework: 'CEFR-inspired (not an official CEFR course)' },
  access: 'plus',
  status: 'available',
  featured: true,
  version: '1.0.0',
  masteryThreshold: 0.7,
  references: [
    { label: 'Council of Europe: CEFR and the Companion Volume (levels and can-do statements)', url: 'https://www.coe.int/en/web/common-european-framework-reference-languages' },
  ],
  sections: [
    section('s1', 'Meeting people', 'Greetings, names and where you are from.', [
      lesson('l1', 'Greeting and introducing yourself', 'By the end of this lesson, you can greet someone, say your name and ask for theirs.', 15, [
        teach('t1', 'explanation', 'Greetings and your name', [
          'French has one everyday greeting for the daytime: Bonjour. In the evening you can say Bonsoir. To say goodbye, use Au revoir.',
          'To say your name, use Je m\u2019appelle followed by your name. It means "I am called". To ask a friend or a child, say Tu t\u2019appelles comment ? To ask politely, say Vous vous appelez comment ?',
          'When you meet someone you can say Enchanté if you are a man, or Enchantée if you are a woman. Both mean "pleased to meet you". The two spellings sound the same.',
        ], { label: 'A short meeting', text: 'Bonjour ! Je m\u2019appelle Amina. Tu t\u2019appelles comment ?\nJe m\u2019appelle Paul. Enchanté !' }),
        act('a1', 'guided', 'Choose the greeting', {
          type: 'choice', prompt: 'It is 8 p.m. and you walk into a restaurant. Which greeting fits best?',
          options: [{ id: 'a', text: 'Bonsoir' }, { id: 'b', text: 'Au revoir' }, { id: 'c', text: 'Enchanté' }],
          answer: 'a',
          why: { b: 'Au revoir means goodbye. You say it when you leave.', c: 'Enchanté means pleased to meet you. It is used after you have been introduced.' },
          hints: ['One option is used to say hello in the evening.'],
          explain: 'Bonsoir is the evening greeting.',
        }),
        act('a2', 'guided', 'Say your name', {
          type: 'fill', prompt: 'Complete the sentence so it means "My name is Sara": Je ____ Sara.',
          accept: ['m\u2019appelle', 'm\'appelle'], display: 'm\u2019appelle',
          hints: ['The verb is s\u2019appeler. After je it becomes m\u2019appelle.', 'Do not forget the apostrophe.'],
          explain: 'Je m\u2019appelle Sara. The m\u2019 comes from me and joins the verb.',
        }),
        act('a3', 'independent', 'Put the conversation in order', {
          type: 'order', prompt: 'Put this short conversation in the right order.',
          items: ['Bonjour !', 'Je m\u2019appelle Léa. Et toi ?', 'Je m\u2019appelle Marc.', 'Enchanté !'],
          hints: ['Someone greets first. Then names are exchanged.'],
          explain: 'A greeting comes first, then the names, then Enchanté.',
        }),
        act('a4', 'checkpoint', 'Introduce yourself', {
          type: 'open', mode: 'writing',
          prompt: 'Write a short message in French to someone you meet at a language class. Greet them, say your name, and ask for their name. Use the form you would use with another student (Tu).',
          minWords: 5, minCriteria: 3,
          rubric: [
            { id: 'greet', label: 'Starts with a correct greeting such as Bonjour or Salut.' },
            { id: 'name', label: 'Says the writer\u2019s name using Je m\u2019appelle (an apostrophe style difference is fine).' },
            { id: 'ask', label: 'Asks for the other person\u2019s name using Tu t\u2019appelles comment ? or Et toi ?' },
          ],
          hints: ['Three parts: a greeting, your name, then a question.'],
          exemplar: 'Bonjour ! Je m\u2019appelle Kemi. Tu t\u2019appelles comment ?',
          explain: 'A complete answer has a greeting, your name and a question.',
        }),
      ]),
      lesson('l2', 'Saying where you are from', 'By the end of this lesson, you can say where you are from and ask another person where they are from.', 20, [
        teach('t1', 'explanation', 'The verb être and the word de', [
          'The verb être means "to be". For je (I) it is je suis. For tu (you, informal) it is tu es. For il (he) and elle (she) it is il est and elle est.',
          'To say where you are from, use Je suis de followed by a place. Je suis de Lagos. Before a vowel, de becomes d\u2019: Je suis d\u2019Abuja.',
          'To ask, say Tu es d\u2019où ? or, more politely, Vous êtes d\u2019où ? A common answer is Je suis du Nigeria, because Nigeria is a masculine country in French (le Nigeria). That detail is for later. For now, use city names.',
        ], { label: 'Where are you from?', text: 'Tu es d\u2019où ?\nJe suis de Lagos. Et toi ?\nJe suis d\u2019Accra.' }),
        act('b1', 'guided', 'Choose the right form of être', {
          type: 'choice', prompt: 'Which form completes the sentence? "Tu ____ d\u2019Abuja ?"',
          options: [{ id: 'a', text: 'suis' }, { id: 'b', text: 'es' }, { id: 'c', text: 'est' }],
          answer: 'b',
          why: { a: 'suis goes with je.', c: 'est goes with il or elle.' },
          hints: ['Which pronoun is in the sentence?'],
          explain: 'Tu goes with es: Tu es d\u2019Abuja ?',
        }),
        act('b2', 'guided', 'Match pronoun and verb', {
          type: 'match', prompt: 'Match each pronoun to the correct form of être.',
          pairs: [{ left: 'je', right: 'suis' }, { left: 'tu', right: 'es' }, { left: 'elle', right: 'est' }],
          hints: ['Je suis is the one you already used.'],
          explain: 'je suis, tu es, elle est.',
        }),
        act('b3', 'independent', 'Fill in the answer', {
          type: 'fill', prompt: 'Complete: Je suis ____ Lagos.', accept: ['de'], display: 'de',
          hints: ['This small word means "from" here.'], explain: 'Je suis de Lagos. Use d\u2019 only before a vowel.',
        }),
        act('b4', 'checkpoint', 'Write a two-line exchange', {
          type: 'open', mode: 'writing',
          prompt: 'Write two short lines in French. First, say you are from a city of your choice. Second, ask the other person where they are from (use Tu or Vous).',
          minWords: 4, minCriteria: 2,
          rubric: [
            { id: 'from', label: 'Says where the writer is from using Je suis de or Je suis d\u2019 followed by a place.' },
            { id: 'ask', label: 'Asks where the other person is from, for example Tu es d\u2019où ? or Vous êtes d\u2019où ? or Et toi ?' },
          ],
          hints: ['Line one starts with Je suis. Line two is a question.'],
          exemplar: 'Je suis de Lagos. Tu es d\u2019où ?',
          explain: 'You need one sentence about you and one question.',
        }),
      ]),
    ]),
    section('s2', 'Everyday situations', 'Ordering at a café and asking for directions.', [
      lesson('l1', 'Ordering at a café', 'By the end of this lesson, you can order a drink politely and ask for the bill.', 20, [
        teach('t1', 'explanation', 'Polite requests', [
          'To order politely, say Je voudrais, which means "I would like". Add the item, then s\u2019il vous plaît ("please"). Je voudrais un café, s\u2019il vous plaît.',
          'Un is used before masculine nouns: un café, un thé. Une is used before feminine nouns: une eau (a water), une limonade.',
          'To ask for the bill, say L\u2019addition, s\u2019il vous plaît. To thank someone, say Merci.',
        ], { label: 'At the café', text: 'Bonjour ! Je voudrais un thé, s\u2019il vous plaît.\nBien sûr. Voilà.\nMerci !' }),
        act('c1', 'guided', 'Order politely', {
          type: 'choice', prompt: 'Which sentence is a polite way to order a coffee?',
          options: [{ id: 'a', text: 'Je voudrais un café, s\u2019il vous plaît.' }, { id: 'b', text: 'Un café.' }, { id: 'c', text: 'Je suis un café.' }],
          answer: 'a',
          why: { b: 'This is understandable but abrupt. It is missing the polite words.', c: 'Je suis un café means "I am a coffee".' },
          hints: ['Look for Je voudrais and s\u2019il vous plaît.'], explain: 'Je voudrais plus s\u2019il vous plaît makes a polite request.',
        }),
        act('c2', 'guided', 'Un or une?', {
          type: 'match', prompt: 'Match each article to the noun it goes with.',
          pairs: [{ left: 'un', right: 'café' }, { left: 'une', right: 'limonade' }, { left: 'un', right: 'thé' }],
          hints: ['Café and thé are masculine. Limonade is feminine.'], explain: 'un café, une limonade, un thé.',
        }),
        act('c3', 'independent', 'Ask for the bill', {
          type: 'fill', prompt: 'Complete: ____, s\u2019il vous plaît. (You want the bill.)', accept: ['l\u2019addition', 'l\'addition'], display: 'L\u2019addition',
          hints: ['The word starts with l\u2019 and means "the bill".'], explain: 'L\u2019addition, s\u2019il vous plaît.',
        }),
        act('c4', 'checkpoint', 'Order for two', {
          type: 'open', mode: 'writing',
          prompt: 'You are at a café with a friend. Write what you say to the waiter: greet him, order one tea and one water, and say please.',
          minWords: 6, minCriteria: 3,
          rubric: [
            { id: 'greet', label: 'Greets the waiter, for example Bonjour.' },
            { id: 'order', label: 'Orders both a tea (un thé) and a water (une eau) using Je voudrais or Nous voudrions.' },
            { id: 'please', label: 'Includes s\u2019il vous plaît.' },
          ],
          hints: ['Use Je voudrais, then name both drinks.'],
          exemplar: 'Bonjour ! Je voudrais un thé et une eau, s\u2019il vous plaît.',
          explain: 'Greeting, both drinks with the right article, and please.',
        }),
      ]),
      lesson('l2', 'Asking for directions', 'By the end of this lesson, you can ask where a place is and understand three basic directions.', 20, [
        teach('t1', 'explanation', 'Where is it?', [
          'To ask where a place is, say Où est followed by the place. Où est la gare ? means "Where is the station?". La is used for feminine places, le for masculine ones: la gare, le musée.',
          'Three useful directions: tout droit (straight ahead), à gauche (to the left), à droite (to the right).',
          'To get someone\u2019s attention politely, start with Excusez-moi.',
        ], { label: 'Asking the way', text: 'Excusez-moi, où est la gare ?\nC\u2019est tout droit, puis à gauche.\nMerci beaucoup !' }),
        act('d1', 'guided', 'Understand the direction', {
          type: 'choice', prompt: 'What does "à droite" mean?',
          options: [{ id: 'a', text: 'to the left' }, { id: 'b', text: 'to the right' }, { id: 'c', text: 'straight ahead' }],
          answer: 'b', why: { a: 'To the left is à gauche.', c: 'Straight ahead is tout droit.' },
          hints: ['Droite is related to the English word "right".'], explain: 'À droite means to the right.',
        }),
        act('d2', 'guided', 'Match French and English', {
          type: 'match', prompt: 'Match each French direction to its English meaning.',
          pairs: [{ left: 'tout droit', right: 'straight ahead' }, { left: 'à gauche', right: 'to the left' }, { left: 'à droite', right: 'to the right' }],
          hints: ['Match the one you know first, then use what is left.'], explain: 'tout droit = straight ahead, à gauche = left, à droite = right.',
        }),
        act('d3', 'independent', 'Build the question', {
          type: 'order', prompt: 'Put the words in order to ask "Excuse me, where is the museum?"',
          items: ['Excusez-moi,', 'où', 'est', 'le', 'musée', '?'],
          hints: ['Start with the polite opener. The question word comes next.'], explain: 'Excusez-moi, où est le musée ?',
        }),
        act('d4', 'checkpoint', 'Ask and give directions', {
          type: 'open', mode: 'writing',
          prompt: 'Write two lines. First, politely ask where the station is. Second, answer as a helper: tell the person to go straight ahead and then turn left.',
          minWords: 6, minCriteria: 3,
          rubric: [
            { id: 'polite', label: 'The question begins politely, for example Excusez-moi.' },
            { id: 'where', label: 'Asks where the station is with Où est la gare ?' },
            { id: 'dir', label: 'The answer includes tout droit and à gauche.' },
          ],
          hints: ['The station is la gare. Use puis ("then") between the two directions.'],
          exemplar: 'Excusez-moi, où est la gare ? C\u2019est tout droit, puis à gauche.',
          explain: 'A polite opener, the question, and both directions.',
        }),
      ]),
    ]),
  ],
};
