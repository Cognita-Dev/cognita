// learna/courses-speaking.js
// Public Speaking Essentials: 5 sections, 15 lessons, a final assessment and a recorded final speech.
// Spoken tasks are recorded in the browser, transcribed by the server (so measurements cannot be edited by the learner)
// and marked against the rubric. Pace and filler-word rules come from those measurements, not from the model.
import { teach, lesson, section, choice, fill, activity, speakTask, assignment } from './courses-core.js';
import { VIS } from './visuals.js';

const order = (id, phase, title, prompt, items, explain, extra = {}) => activity(id, phase, title, { type: 'order', prompt, items, explain, ...extra });
const match = (id, phase, title, prompt, pairs, explain, extra = {}) => activity(id, phase, title, { type: 'match', prompt, pairs: pairs.map(([left, right]) => ({ left, right })), explain, ...extra });
const write = (id, phase, title, prompt, rubric, exemplar, explain, extra = {}) => activity(id, phase, title, {
  type: 'open', mode: 'writing', prompt, minWords: 15, minCriteria: Math.max(1, rubric.length - 1), rubric, hints: [], exemplar, explain, ...extra,
});
const PACE = { id: 'pace', label: 'Pace is between 100 and 180 words per minute.', metric: 'wpm', min: 100, max: 180 };
const FILL = (n) => ({ id: 'fillers', label: 'No more than ' + n + ' filler words in every 100 words.', metric: 'fillerPer100', max: n });

export const speaking = {
  id: 'public-speaking-essentials',
  title: 'Public Speaking Essentials',
  shortDescription: 'Open strongly, structure a talk, control your voice and deliver with confidence, with recorded practice and feedback.',
  fullDescription: 'A complete beginner course in public speaking. You learn to know an audience, open and close a talk, organise ideas, use your voice and body, tell stories, handle questions and practise with a feedback loop. You do not only read: you record yourself, and Cognita measures your pace and filler words from a real transcript and marks what you said against a clear checklist. The course ends with a short final speech that a reviewer watches before your certificate is issued.',
  category: 'public-speaking', level: 'Beginner', estimatedDuration: '6 hours', estimatedMinutes: 360,
  whoFor: 'Students, teachers, job seekers and professionals who want to speak with more clarity and less stress, in English.',
  prerequisites: ['A phone or computer with a microphone', 'A camera for the final video task (optional practice tasks need only audio)', 'A quiet place to record'],
  learningOutcomes: [
    'Describe an audience and shape a message for it', 'Open a talk in under 20 seconds and close with a clear call to action', 'Organise a short talk in three parts with signposts',
    'Control pace, pauses, volume and pitch', 'Reduce filler words', 'Use a story or example to make a point memorable', 'Design simple slides that support a talk', 'Answer questions calmly and practise with a feedback loop',
  ],
  skills: ['Audience', 'Openings', 'Structure', 'Voice', 'Pauses', 'Body language', 'Storytelling', 'Slides', 'Q and A', 'Self-review'],
  practical: 'Short written scripts, recorded speaking tasks with measured feedback, and a final speech recorded on video.',
  assessment: 'Questions are checked exactly. Written scripts are marked against a checklist. Recorded speeches are transcribed and measured by Cognita, so pace and filler counts are real. Each lesson needs 70% of its activities passed without seeing the answer. The final assessment needs 75%. The final video is reviewed by a person before a certificate is issued.',
  modes: ['writing', 'speaking', 'recording', 'video'],
  cover: VIS.spCover.src,
  access: 'plus', status: 'available', featured: true, version: '2.0.0', masteryThreshold: 0.7, levelSystem: 'Beginner / Intermediate / Advanced',
  certificate: { enabled: true, title: 'Certificate in Public Speaking Essentials' },
  references: [],
  sections: [
    section('s1', 'Foundations', 'Know where you start, who you are speaking to, and how to stay calm.', [
      lesson('l1', 'Your starting point', 'By the end of this lesson, you have recorded a first speech and know what you want to improve.', 20, [
        teach('t1', 'introduction', 'Why record yourself', [
          'Most people have never heard themselves speak for a full minute. A first recording shows you where you really are. It is not a test. Nobody else is scored on it, and it is the baseline you will compare with at the end.',
          'Speak naturally for about one minute: introduce yourself, say what you do, and say why you want to speak better. Do not read from a script.',
        ]),
        assignment('a1', 'attempt', 'Record your starting point', {
          format: 'audio', review: 'auto', certRequired: false, minSeconds: 30, maxSeconds: 120, maxAttempts: 3,
          prompt: 'Record yourself for 30 to 90 seconds. Introduce yourself, say what you do, and say why you want to speak better.',
          rubric: [{ id: 'who', label: 'Says who they are or what they do.' }, { id: 'why', label: 'Says why they want to improve their speaking.' }],
          metricRules: [], checklist: ['Find a quiet place', 'Hold the phone at chest height', 'Speak as if to one friend'],
        }),
        choice('a2', 'checkpoint', 'The purpose of this recording', 'What is the first recording for?', ['To get a score that counts for your certificate', 'To give you a baseline to improve from', 'To be shared with other learners'], 1, 'It is a baseline. It does not count towards the certificate and is private to you and the reviewers of your account.'),
      ]),
      lesson('l2', 'Know your audience', 'By the end of this lesson, you can describe an audience and say what they need from you.', 25, [
        teach('t1', 'explanation', 'Three questions', [
          'Before you write a word, ask who they are, what they already know, and what they need from you. The same message sounds different to pupils, to parents and to a head teacher.',
          'People listen when a talk answers a question they already have. Start from their need, not from your topic.',
        ], null, { visual: VIS.spAudience, listen: true }),
        match('a1', 'guided', 'Match the question to the choice', 'Match each audience question to the choice it helps you make.', [['Who are they?', 'Your words and examples'], ['What do they know?', 'What to skip or explain'], ['What do they need?', 'Where to start']], 'Who they are shapes your words, what they know shapes how much to explain, and what they need shapes your starting point.'),
        choice('a2', 'guided', 'Adjust the message', 'You must explain a new school rule to 8-year-olds. What is the best approach?', ['Use the exact words from the rule book', 'Use short sentences and one example from their day', 'Give a long history of the rule'], 1, 'Young listeners need short sentences and concrete examples they recognise.'),
        write('a3', 'attempt', 'Describe your audience', 'Choose a talk you may give soon. In 3 or 4 sentences, say who the audience is, what they already know, and what they need from you.',
          [{ id: 'who', label: 'Says who the audience is.' }, { id: 'know', label: 'Says what they already know or do not know.' }, { id: 'need', label: 'Says what they need from the talk.' }],
          'My audience is the parents of JSS 1 pupils. They know the school but not the new timetable. They need to know what changes for their child and what they must do by Friday.', 'Who, what they know, what they need.'),
      ]),
      lesson('l3', 'Managing nerves', 'By the end of this lesson, you can use a breathing routine and a short preparation habit to feel steadier before speaking.', 20, [
        teach('t1', 'explanation', 'Nerves are normal', [
          'Most speakers feel nervous. A faster heartbeat and a dry mouth are signs of energy, and you can put that energy to work. Preparation is the strongest tool: the better you know your opening, the calmer you will be for the first minute.',
          'A slow breathing pattern helps your body settle. Breathe in for 4 counts, hold for 2, and breathe out slowly for 6. Repeat three times. If you feel dizzy, stop and breathe normally.',
        ], null, { visual: VIS.spBreath, listen: true }),
        order('a1', 'guided', 'The breathing routine', 'Put the breathing routine in order.', ['In through the nose for 4 counts', 'Hold gently for 2 counts', 'Out slowly for 6 counts', 'Repeat three times'], 'In, hold, out, then repeat.', { hints: ['Start with the breath in.'] }),
        choice('a2', 'guided', 'Best preparation', 'Which habit does the most to reduce nerves in the first minute?', ['Memorising every word', 'Knowing your opening very well', 'Avoiding looking at anyone'], 1, 'If you know your opening well, you start strongly and the rest follows. Memorising everything makes you panic if you forget one word.'),
        speakTask('a3', 'attempt', 'Say your calm sentence', 'Choose a calm sentence you can say to yourself. Read this one aloud slowly, then say it in your own words.', 'I have prepared well, and I will take my time.', { lang: 'en-NG' }),
        write('a4', 'checkpoint', 'Your routine', 'Write your own pre-talk routine in 3 or 4 sentences. Include breathing and one other thing you will do.',
          [{ id: 'breath', label: 'Includes a breathing step.' }, { id: 'other', label: 'Includes at least one other practical step, such as knowing the opening or checking the room.' }],
          'Ten minutes before, I will check the room and my slides. Then I will breathe in for four counts and out for six, three times. I will say my opening to myself once.', 'A breathing step and one practical step.'),
      ]),
    ]),
    section('s2', 'Opening and structure', 'Start well, organise your ideas and finish clearly.', [
      lesson('l1', 'Opening a talk', 'By the end of this lesson, you can open a talk with a hook that names the topic in under 20 seconds.', 25, [
        teach('t1', 'explanation', 'The first 20 seconds', [
          'Your audience decides quickly whether to listen. A strong opening gives them a reason to care and tells them what the talk is about.',
          'Three simple openings work well: a surprising fact, a short question, or a one-sentence story. Avoid an apology ("Sorry, I am not very good at this") and avoid "Today I will be talking about".',
        ], { label: 'Example', text: 'Every year, our school loses about 40 hours of teaching time to paper registers. Today I will show you how to get those hours back.' }, { visual: VIS.spOpenings, listen: true }),
        choice('a1', 'guided', 'Spot the weak opening', 'Which opening is weakest?', ['Sorry, I am a bit nervous, so please bear with me.', 'How many hours did you waste in meetings this week?', 'Last month a customer called me at midnight, and she was right to.'], 0, 'An apology makes people watch for mistakes instead of listening.', { why: { 1: 'A question makes the audience think about their own experience.', 2: 'A short story creates curiosity.' }, hints: ['One opening gives the audience a reason to doubt you.'] }),
        write('a2', 'attempt', 'Write your opening', 'Write an opening of two or three sentences for a 3-minute talk to your class about why people should sleep eight hours. Use a surprising fact, a question or a short story. Do not apologise.',
          [{ id: 'hook', label: 'Begins with a hook: a fact, a question or a short story.' }, { id: 'topic', label: 'Makes clear that the talk is about sleep.' }, { id: 'noapology', label: 'Contains no apology and does not begin with "Today I will be talking about".' }],
          'When did you last wake up feeling truly rested? Most of us cannot remember, and it is costing our marks. In the next three minutes, I will show you why eight hours matters.', 'A hook first, then the topic, with no apology.', { hints: ['Try starting with a question about the last time they felt tired.'] }),
        speakTask('a3', 'independent', 'Say it aloud', 'Read this opening aloud. Then say your own opening from the last task aloud, without reading.', 'When did you last wake up feeling truly rested? Most of us cannot remember.', { mode: 'read', lang: 'en-NG' }),
        choice('a4', 'checkpoint', 'Choose the stronger opening', 'You will speak about saving money. Which opening is strongest?', ['Today I will be talking about saving money.', 'If you saved just \u20a65,000 a month, you would have \u20a660,000 in a year. Here is how.', 'Um, so, hi everyone, I guess I will start now.'], 1, 'It gives a concrete benefit and promises how.', { why: { 0: 'It names the topic but gives no reason to care.', 2: 'Filler words and hesitation weaken the opening.' }, hints: ['Look for a specific number and a promise.'] }),
      ], 2),
      lesson('l2', 'Structure: open, body, close', 'By the end of this lesson, you can organise a short talk into an opening, three points and a close.', 30, [
        teach('t1', 'explanation', 'A talk in three parts', [
          'Tell them where you are going, go there, then say where you arrived. The opening has a hook, the topic and a preview. The body has up to three points, each with proof or an example. The close has a summary, a call to action and a final line.',
          'For a short talk keep to three points. Fewer is fine. More than three is hard to remember.',
        ], null, { visual: VIS.spStructure, listen: true }),
        order('a1', 'guided', 'Order the talk', 'Put the parts of a talk in order.', ['Hook', 'Topic and preview', 'Point 1 with example', 'Point 2 with example', 'Summary and call to action'], 'Hook, topic, then points, then close.'),
        choice('a2', 'guided', 'The call to action', 'What is a call to action?', ['A summary of every point', 'A clear thing you want the audience to do next', 'A joke at the end'], 1, 'It tells the audience what to do with what they heard.'),
        write('a3', 'attempt', 'Outline a talk', 'Outline a 3-minute talk on why pupils should read for 20 minutes a day. Write one line for the opening, three lines for the points, and one line for the close.',
          [{ id: 'open', label: 'Has an opening line with a hook or topic.' }, { id: 'points', label: 'Has three distinct points.' }, { id: 'close', label: 'Has a closing line that includes a call to action.' }],
          'Opening: A question about the last book they finished. Point 1: reading improves vocabulary. Point 2: it improves concentration. Point 3: it is free at the library. Close: pick a book tonight and read for 20 minutes.', 'An opening, three points, and a close with an action.', { minWords: 25 }),
      ]),
      lesson('l3', 'Signposting and one clear message', 'By the end of this lesson, you can state one main message and use signposts to guide listeners.', 20, [
        teach('t1', 'explanation', 'One message, clear signs', [
          'A good talk has one main message that you can say in one sentence. Everything else supports it. If a point does not support the message, cut it.',
          'Signposts are short phrases that tell listeners where they are: "First", "The second reason", "Let me finish with". They help people who lose focus for a moment to find the thread again.',
        ]),
        choice('a1', 'guided', 'Find the signpost', 'Which phrase is a signpost?', ['Um, so basically', 'The second reason is cost', 'Anyway'], 1, 'It tells listeners which point they are on.'),
        fill('a2', 'guided', 'Complete the signpost', 'Type the missing word: "Let me ___ with a story." (to end the talk)', ['finish', 'close', 'end', 'conclude'], 'These all signal that the close is coming.', { hints: ['It means the talk is about to end.'] }),
        write('a3', 'attempt', 'Your main message', 'Write the main message of a talk you could give, in one sentence. Then write two signpost phrases you would use.',
          [{ id: 'msg', label: 'States one main message in one sentence.' }, { id: 'sign', label: 'Includes two signpost phrases.' }],
          'Main message: Walking to school every day makes pupils healthier and more focused. Signposts: "The first benefit is health" and "My second reason is focus".', 'One message and two signposts.', { minWords: 15 }),
      ]),
    ]),
    section('s3', 'Voice and body', 'Use pace, pauses, volume, pitch and posture on purpose.', [
      lesson('l1', 'Four dials of the voice', 'By the end of this lesson, you can name the four voice dials and choose settings for a message.', 20, [
        teach('t1', 'explanation', 'Pace, volume, pitch and pause', [
          'Your voice has four dials. Pace is how fast you speak. Volume is how loud. Pitch is how high or low. Pause is the silence between ideas. A speaker who changes them on purpose is easier to follow than one who stays on a single setting.',
          'Slow down for numbers and key ideas. Speak to the person at the back of the room. Vary your pitch so you do not sound flat.',
        ], null, { visual: VIS.spVoice, listen: true }),
        match('a1', 'guided', 'Match the dial', 'Match each voice dial to what it controls.', [['Pace', 'How fast you speak'], ['Volume', 'How loud you are'], ['Pitch', 'How high or low you sound'], ['Pause', 'The silence between ideas']], 'Each dial is separate. You can change one without changing the others.'),
        choice('a2', 'guided', 'Which dial?', 'You are about to say an important number. Which change helps most?', ['Speak faster', 'Slow down and pause after it', 'Speak more quietly'], 1, 'Slowing down and pausing gives listeners time to take the number in.'),
        assignment('a3', 'attempt', 'Record with varied pace', {
          format: 'audio', review: 'auto', certRequired: false, minSeconds: 30, maxSeconds: 90, maxAttempts: 3,
          prompt: 'Record yourself for 30 to 60 seconds describing your journey to school or work. Slow down for one important detail and speak clearly.',
          rubric: [{ id: 'journey', label: 'Describes a journey with at least two details.' }, { id: 'detail', label: 'Gives one detail that is clearly marked as important.' }],
          metricRules: [PACE], checklist: ['Speak at a steady pace', 'Slow down for the important detail'],
        }),
      ]),
      lesson('l2', 'Pace and pauses', 'By the end of this lesson, you can use pauses to give ideas room and replace filler words with silence.', 25, [
        teach('t1', 'explanation', 'Silence is part of the sound', [
          'A short pause of about a second lets you think of the next phrase. A longer pause of two or three seconds after your most important sentence lets it land. Pauses feel long to you and natural to the audience.',
          'A comfortable pace for most listeners is roughly 120 to 160 words per minute. Nerves usually make people faster, so check your pace when you practise.',
        ], null, { visual: VIS.spPause, listen: true }),
        speakTask('a1', 'guided', 'Read with pauses', 'Read this aloud. Pause for one second at each slash.', 'We lost forty hours. / Every single year. / Here is how we fix it.', { mode: 'read', lang: 'en-NG' }),
        choice('a2', 'guided', 'Where to pause', 'Where is the best place for a long pause?', ['In the middle of a word', 'Right after your most important sentence', 'Before every sentence'], 1, 'A pause after the key idea gives it time to land.'),
        assignment('a3', 'attempt', 'Record a paced talk', {
          format: 'audio', review: 'auto', certRequired: true, minSeconds: 45, maxSeconds: 120, maxAttempts: 4,
          prompt: 'Record a 45 to 90 second talk on one habit that helps you study or work. Use at least two deliberate pauses after key ideas.',
          rubric: [{ id: 'habit', label: 'Talks about one clear habit.' }, { id: 'reason', label: 'Gives a reason or example for why it helps.' }],
          metricRules: [PACE, FILL(6)], checklist: ['Pause after key ideas', 'Replace "um" with silence'],
        }),
      ]),
      lesson('l3', 'Body language', 'By the end of this lesson, you can describe four simple habits of posture, eyes, hands and feet.', 20, [
        teach('t1', 'explanation', 'Simple habits, no acting', [
          'Your body speaks while you do. Look at one person for one whole thought, then move to another. Keep your shoulders relaxed and breathe low. Let your hands rest at waist height and use them to show size, number or order. Stand with your feet about shoulder width apart.',
          'Move on purpose, for example when you start a new point, and stay still when you make a key statement. Tap the numbered points on the picture.',
        ], null, { visual: VIS.spBody }),
        match('a1', 'guided', 'Match the habit', 'Match each part of the body to a good habit.', [['Eyes', 'Hold contact for a whole thought'], ['Shoulders', 'Relaxed and open'], ['Hands', 'Rest at waist height, gesture with meaning'], ['Feet', 'Steady, shoulder width apart']], 'Each habit helps you look calm and look at your audience.'),
        choice('a2', 'guided', 'Fix the habit', 'A speaker keeps swaying from side to side. What is the best fix?', ['Hold a pen tightly', 'Plant both feet and move only when starting a new point', 'Look at the floor'], 1, 'A steady stance stops swaying. Moving on purpose looks confident.'),
        assignment('a3', 'attempt', 'Record a short video', {
          format: 'video', review: 'admin', certRequired: false, minSeconds: 20, maxSeconds: 60, maxAttempts: 3,
          prompt: 'Record a video of 20 to 45 seconds in which you introduce yourself while standing or sitting up straight. A reviewer will watch it and give you one note on eye contact and posture.',
          rubric: [], metricRules: [], checklist: ['Look at the camera lens, not the screen', 'Keep your shoulders relaxed', 'Hold the phone steady at eye height'],
          reviewGuide: 'Watch the video. Give one note on eye contact and one on posture or gesture. Approve if the learner is visible, audible and speaking to the camera.',
        }),
      ]),
      lesson('l4', 'Filler words', 'By the end of this lesson, you can name common filler words and replace them with a pause.', 20, [
        teach('t1', 'explanation', 'Um, like, you know', [
          'Filler words such as um, uh, like, you know, basically and actually fill silence while you think. A few are normal. Many make you sound unsure and distract listeners.',
          'You usually cannot hear your own fillers until you listen back. The fix is not to try harder to avoid them. It is to pause quietly instead. A pause is silent, and nobody notices it the way they notice an "um".',
        ]),
        choice('a1', 'guided', 'Which is a filler?', 'Which of these is a filler word?', ['Therefore', 'Basically', 'Tomorrow'], 1, 'Basically is often used as a filler that adds nothing.'),
        choice('a2', 'guided', 'The best fix', 'What is the best way to reduce fillers?', ['Speak faster so there is no time for them', 'Pause silently instead', 'Never stop speaking'], 1, 'A silent pause replaces the filler and gives you thinking time.'),
        assignment('a3', 'attempt', 'Record a low-filler answer', {
          format: 'audio', review: 'auto', certRequired: true, minSeconds: 45, maxSeconds: 120, maxAttempts: 4,
          prompt: 'Record a 45 to 90 second answer to this question: "What is one thing you would like people to know about your school or workplace?" Pause instead of using fillers.',
          rubric: [{ id: 'answer', label: 'Gives one clear thing about the school or workplace.' }, { id: 'support', label: 'Supports it with a reason or example.' }],
          metricRules: [PACE, FILL(4)], checklist: ['Pause instead of saying um', 'Keep a steady pace'],
        }),
      ]),
    ]),
    section('s4', 'Craft your content', 'Stories, persuasion and slides.', [
      lesson('l1', 'Stories', 'By the end of this lesson, you can tell a short story in five beats to make a point.', 25, [
        teach('t1', 'explanation', 'A story in five beats', [
          'A short story makes a point memorable. Use five beats: the situation, the problem, the turning point, the result and the lesson. In a three-minute talk a story should take about thirty seconds.',
          'Always tie the story back to your point. Say what it means for the audience.',
        ], null, { visual: VIS.spStory, listen: true }),
        order('a1', 'guided', 'Order the beats', 'Put the story beats in order.', ['Situation', 'Problem', 'Turning point', 'Result', 'Lesson'], 'Set the scene, add the problem, show the change, show the result, then give the lesson.'),
        write('a2', 'attempt', 'Write a story', 'Write a short story of 4 to 6 sentences about a time you learned something, using the five beats. End with what it means for your audience.',
          [{ id: 'problem', label: 'Includes a clear problem.' }, { id: 'turn', label: 'Includes a moment where things changed.' }, { id: 'lesson', label: 'Ends with a lesson for the audience.' }],
          'In my first year I missed a deadline because I left my project to the last night. The printer broke at midnight. I asked my neighbour, who let me use hers, and I handed in on time. Now I finish a day early, and you can too.', 'Problem, turning point, lesson.', { minWords: 30 }),
        assignment('a3', 'independent', 'Tell it aloud', {
          format: 'audio', review: 'auto', certRequired: true, minSeconds: 30, maxSeconds: 120, maxAttempts: 4,
          prompt: 'Tell your story aloud in 30 to 90 seconds. Do not read it. Finish with the lesson for your audience.',
          rubric: [{ id: 'problem', label: 'The story has a clear problem.' }, { id: 'change', label: 'The story has a moment where things changed.' }, { id: 'lesson', label: 'The speaker ends with a lesson for the listener.' }],
          metricRules: [PACE], checklist: ['Do not read word for word', 'Pause before the turning point'],
        }),
      ]),
      lesson('l2', 'Persuasion', 'By the end of this lesson, you can use credibility, emotion and logic to support a message.', 25, [
        teach('t1', 'explanation', 'Three ways to persuade', [
          'Credibility answers "why listen to you?": show your experience or sources, and be honest about what you do not know. Emotion answers "why should I care?": a real example helps people feel why it matters. Logic answers "why is it true?": clear reasons, numbers and examples.',
          'Strong talks use all three. Do not exaggerate. Audiences notice, and it costs you trust.',
        ], null, { visual: VIS.spPersuade }),
        match('a1', 'guided', 'Match the appeal', 'Match each appeal to the question it answers.', [['Credibility', 'Why listen to you?'], ['Emotion', 'Why should I care?'], ['Logic', 'Why is it true?']], 'Each appeal answers a different doubt.'),
        choice('a2', 'guided', 'Which appeal?', '"Last year I trained 200 teachers in this method." Which appeal is this?', ['Credibility', 'Emotion', 'Logic'], 0, 'It shows experience, which builds credibility.'),
        write('a3', 'attempt', 'Use all three', 'You want your school to start a reading club. Write three sentences: one that builds credibility, one that uses emotion, and one that uses logic.',
          [{ id: 'cred', label: 'Includes a sentence that builds credibility.' }, { id: 'emo', label: 'Includes a sentence that appeals to feeling with an example.' }, { id: 'logic', label: 'Includes a sentence with a reason or fact.' }],
          'I have run a reading club at my church for two years. One pupil told me it was the first book she ever finished. Pupils who read 20 minutes a day usually gain vocabulary faster.', 'One sentence for each appeal.', { minWords: 20 }),
      ]),
      lesson('l3', 'Slides that help', 'By the end of this lesson, you can say what makes a slide help or hurt a talk.', 20, [
        teach('t1', 'explanation', 'Support, do not replace', [
          'People cannot read and listen at the same time. A slide full of text makes them stop listening to you. Put one idea on each slide: one number, one picture, or a few words. You supply the explanation by speaking.',
          'Do not read your slides aloud. Face the audience, not the screen.',
        ], null, { visual: VIS.spSlides }),
        choice('a1', 'guided', 'Better slide', 'Which slide is better for a talk?', ['Seven bullet points of full sentences', 'One large number with a few words', 'A paragraph copied from a report'], 1, 'One idea, big and clear, lets the audience listen.'),
        choice('a2', 'guided', 'Reading slides', 'Why should you not read your slides aloud?', ['It takes too long', 'People can read faster than you speak, so you add nothing', 'It is against the rules'], 1, 'The audience reads ahead and stops listening to you.'),
        write('a3', 'attempt', 'Plan three slides', 'Plan three slides for a talk on a topic you know. For each slide write the single idea and what you would show (a number, a picture or a few words).',
          [{ id: 'three', label: 'Describes three slides.' }, { id: 'one', label: 'Each slide has a single idea.' }, { id: 'show', label: 'Says what is shown on each slide, not a block of text.' }],
          'Slide 1: 40 hours lost, shown as the number 40. Slide 2: the old register, shown as a photo. Slide 3: the new app, shown as a screenshot with the word Faster.', 'Three slides, one idea each.', { minWords: 25 }),
      ]),
    ]),
    section('s5', 'Delivering with confidence', 'Questions, practice and your final speech.', [
      lesson('l1', 'Handling questions', 'By the end of this lesson, you can follow a five-step routine when someone asks a question.', 20, [
        teach('t1', 'explanation', 'A routine for questions', [
          'Listen to the whole question. Pause for a breath. Repeat the question briefly so the room hears it. Answer with the answer first, then one reason. Check whether you answered it. If you do not know, say so and say how you will find out.',
        ], null, { visual: VIS.spQa, listen: true }),
        order('a1', 'guided', 'Order the routine', 'Put the five steps in order.', ['Listen', 'Pause', 'Repeat the question', 'Answer', 'Check'], 'Listen, pause, repeat, answer, check.'),
        choice('a2', 'guided', 'You do not know', 'Someone asks something you cannot answer. What is best?', ['Make something up', 'Say you do not know and how you will find out', 'Change the subject'], 1, 'Honesty builds trust. Offering to find out shows you take the question seriously.'),
        assignment('a3', 'attempt', 'Answer a question aloud', {
          format: 'audio', review: 'auto', certRequired: true, minSeconds: 20, maxSeconds: 90, maxAttempts: 4,
          prompt: 'Imagine a listener asks: "Why should I spend my time on this?" Record a 20 to 60 second answer. Give the answer first, then one reason.',
          rubric: [{ id: 'first', label: 'Gives the answer before the reasons.' }, { id: 'reason', label: 'Gives at least one clear reason.' }],
          metricRules: [PACE, FILL(5)], checklist: ['Answer first', 'One reason', 'Stop'],
        }),
      ]),
      lesson('l2', 'The practice loop', 'By the end of this lesson, you can run a feedback loop to improve one thing at a time.', 20, [
        teach('t1', 'explanation', 'Record, listen, fix one thing', [
          'Improvement comes from small, repeated cycles. Record yourself. Listen back once for content and once for delivery. Pick one fix. Speak it again. Three rounds beat one long rehearsal.',
          'Choosing only one fix matters. Trying to fix five things at once usually fixes none.',
        ], null, { visual: VIS.spFeedback }),
        order('a1', 'guided', 'Order the loop', 'Put the loop in order.', ['Record yourself', 'Listen back', 'Pick one fix', 'Speak it again'], 'Record, listen, choose one fix, speak again.'),
        write('a2', 'attempt', 'Plan your practice', 'Write your practice plan for the final speech in 3 or 4 sentences. Say how many rounds you will do and what one fix you will start with.',
          [{ id: 'rounds', label: 'Says how many rounds or when they will practise.' }, { id: 'fix', label: 'Names one specific fix to start with.' }],
          'I will record three rounds this week. My first fix will be pausing instead of saying um. After that I will work on a slower pace in the opening.', 'Rounds and one fix.'),
      ]),
      lesson('l3', 'Final assessment', 'By the end of this assessment, you can show that you know the main ideas of the course. You need 75% to pass.', 30, [
        teach('t1', 'introduction', 'Before you begin', ['This is an assessment. Your tutor can explain what a question is asking but will not help you answer it. You have three tries on each question.']),
        choice('f1', 'checkpoint', 'Opening', 'Which opening is best?', ['Sorry, I did not prepare much.', 'Last week a pupil asked me a question I could not answer. Today I will answer it.', 'Today I will be talking about homework.'], 1, 'A short story with a promise gives a reason to listen.', { hints: [] }),
        choice('f2', 'checkpoint', 'Structure', 'How many main points are best for a short talk?', ['One to three', 'Seven to ten', 'As many as you can fit'], 0, 'Three is the most listeners can hold in a short talk.', { hints: [] }),
        choice('f3', 'checkpoint', 'Pause', 'What is the best use of a long pause?', ['After your most important sentence', 'Before every word', 'During a question'], 0, 'It lets the key idea land.', { hints: [] }),
        choice('f4', 'checkpoint', 'Fillers', 'What is the best way to avoid saying "um"?', ['Pause silently', 'Talk faster', 'Whisper'], 0, 'A silent pause replaces the filler.', { hints: [] }),
        choice('f5', 'checkpoint', 'Slides', 'What is the best slide for a key number?', ['One large number with a few words', 'A paragraph', 'A table of twenty numbers'], 0, 'One idea, big and clear.', { hints: [] }),
        match('f6', 'checkpoint', 'Appeals', 'Match each persuasion appeal to what it does.', [['Credibility', 'Shows why to trust you'], ['Emotion', 'Shows why it matters'], ['Logic', 'Shows why it is true']], 'Each answers a different question.', { hints: [] }),
        choice('f7', 'checkpoint', 'Questions', 'What should you do first when someone asks a question?', ['Answer at once', 'Listen to the whole question', 'Disagree'], 1, 'Listen first, then pause.', { hints: [] }),
        choice('f8', 'checkpoint', 'Nerves', 'Which helps most in the first minute?', ['Knowing your opening well', 'Memorising everything', 'Avoiding eye contact'], 0, 'A well-known opening gives a confident start.', { hints: [] }),
      ], 1, { exam: true, threshold: 0.75 }),
      lesson('l4', 'Your final speech', 'By the end of this lesson, you have recorded a final speech for review and you can compare it with your starting point.', 45, [
        teach('t1', 'introduction', 'The final task', [
          'You will record a three-part talk of about two minutes on a topic of your choice: an opening with a hook, two or three points with an example, and a close with a call to action. First, record it as audio. Cognita will measure your pace and fillers and mark what you said. Then record the same talk on video for a reviewer.',
          'Use the practice loop. Do at least two rounds before you submit.',
        ]),
        assignment('a1', 'attempt', 'Final speech: audio', {
          format: 'audio', review: 'auto', certRequired: true, minSeconds: 60, maxSeconds: 180, maxAttempts: 5,
          prompt: 'Record your final talk, 60 to 150 seconds. Include an opening with a hook, two or three points with an example, and a close with a call to action.',
          rubric: [
            { id: 'hook', label: 'Opens with a hook: a fact, a question or a short story.' }, { id: 'topic', label: 'States the topic early.' }, { id: 'points', label: 'Makes at least two clear points.' },
            { id: 'example', label: 'Supports a point with an example.' }, { id: 'cta', label: 'Closes with a call to action.' },
          ],
          minCriteria: 4, metricRules: [PACE, FILL(4)], checklist: ['Hook, topic, points, close', 'Pause instead of fillers', 'A steady pace'],
        }),
        assignment('a2', 'independent', 'Final speech: video for review', {
          format: 'video', review: 'admin', certRequired: true, minSeconds: 60, maxSeconds: 180, maxAttempts: 5,
          prompt: 'Record the same talk on video, 60 to 150 seconds. Look at the camera. A reviewer will watch it and decide whether it meets the standard.',
          rubric: [], metricRules: [], checklist: ['Camera at eye height', 'Good light on your face', 'Look at the lens'],
          reviewGuide: 'Watch the whole video. Check there is a clear opening, at least two points and a close. Check the speaker is audible and looks at the camera. Approve if the talk meets the standard for a beginner. If not, say the one most useful thing to fix and ask for another recording.',
        }),
        write('a3', 'reflection', 'Compare with your start', 'Write 4 or 5 sentences comparing your final speech with your starting-point recording. Say what improved and what you will work on next.',
          [{ id: 'improved', label: 'Names something that improved.' }, { id: 'next', label: 'Names something to work on next.' }],
          'My pace is steadier now and I use pauses instead of um. My opening is stronger. Next I want to work on eye contact and on telling the story without notes.', 'What improved and what is next.', { minWords: 25, voice: true }),
      ], 1),
    ]),
  ],
};
