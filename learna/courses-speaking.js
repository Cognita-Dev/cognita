// learna/courses-speaking.js
// Public Speaking Essentials: 5 sections, 17 lessons, a final assessment and a recorded final speech.
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
  category: 'public-speaking', level: 'Beginner', estimatedDuration: '9 to 10 hours', estimatedMinutes: 570,
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
  access: 'plus', status: 'available', featured: true, version: '2.1.0', masteryThreshold: 0.7, levelSystem: 'Beginner / Intermediate / Advanced',
  certificate: { enabled: true, title: 'Certificate in Public Speaking Essentials' },
  references: [],
  sections: [
    section('s1', 'Foundations', 'Know where you start, who you are speaking to, and how to stay calm.', [
      lesson('l1', 'Your starting point', 'By the end of this lesson, you have recorded a first speech and know what you want to improve.', 30, [
        teach('t1', 'introduction', 'Why record yourself', [
          `Most people have never heard themselves speak for a full minute. We hear our own voice partly through the bones of our head, so it sounds deeper and fuller to us than it does to everyone else. That is why many people dislike the first recording they hear. The dislike is normal, and it fades quickly once you practise listening to yourself the way a stranger would.`,
          `A first recording is a baseline. A baseline is a starting measurement, like the weight and height a clinic writes down on your first visit. Nobody else is scored on it and it does not count towards your certificate. Its only job is to show you where you really are, so that when you record your final speech you can hear the difference with your own ears instead of hoping that there is one.`,
          `Without a baseline, improvement is only a feeling. With one, it is evidence. Many learners believe they hardly ever say "um" until they listen and count. Others believe they speak far too fast and discover that their pace is fine and their pauses are missing. You cannot fix what you cannot hear, and a recording is the only honest mirror a speaker has.`,
          `In this lesson you will do three things. First, you will learn how to record so that the recording is fair to you. Second, you will record about a minute of natural speech. Third, you will learn how to listen back without being harsh on yourself, and you will write three short notes that guide the rest of the course.`,
        ], { label: 'What a baseline note can look like', text: `Length of recording: 1 minute 10 seconds
What I liked: I sounded friendly and my introduction was clear.
What I noticed: I said "you know" about eight times and I rushed my last sentence.
What I will work on first: pausing silently instead of saying "you know".` }),
        teach('t2', 'explanation', 'How to record a fair first take', [
          `Good conditions make the recording fair. Choose the quietest place you have: a closed room, a parked car, or a corner of the house away from the television. In many homes the generator, a ceiling fan or a loudspeaker down the road is louder than we notice, because our ears get used to it. Listen for ten seconds before you press record, and move if the noise is strong. Cognita turns your recording into text, and clear sound gives a more accurate result.`,
          `Hold the phone about the width of a hand from your mouth, slightly below your lips, or lean it against a book at chest height with the microphone facing you. Do not cover the microphone with your fingers. Check that you have enough battery and storage before you start, because a recording that stops halfway is discouraging. If the browser asks for permission to use the microphone, allow it. If nothing records, check the site settings in your browser.`,
          `Speak the way you would speak to one friend sitting across a table from you. Do not read from a script, because reading changes your voice and hides your real habits. If you lose your words, pause, take a breath and continue. Mistakes in a baseline are useful, because they show you what you do when you are under a little pressure.`,
          `Do not worry about your accent. Every Nigerian accent, and every other accent, is acceptable in public speaking. What matters is clarity, not sounding foreign. Clarity comes from saying each word fully, finishing your sentences and stressing the important words. You will practise all three in later lessons.`,
        ], { label: 'A simple plan for one minute', text: `Sentence 1: My name is ___ and I am a ___.
Sentence 2: In my work or studies, I spend most of my time on ___.
Sentence 3: I want to speak better because ___.
Sentence 4: The situation where I most want to be confident is ___.` }),
        assignment('a1', 'attempt', 'Record your starting point', {
          format: 'audio', review: 'auto', certRequired: false, minSeconds: 30, maxSeconds: 120, maxAttempts: 3,
          prompt: 'Record yourself for 30 to 90 seconds. Introduce yourself, say what you do, and say why you want to speak better.',
          rubric: [{ id: 'who', label: 'Says who they are or what they do.' }, { id: 'why', label: 'Says why they want to improve their speaking.' }],
          metricRules: [], checklist: ['Find a quiet place', 'Hold the phone at chest height', 'Speak as if to one friend'],
        }),
        teach('t3', 'explanation', 'Listening back without being harsh', [
          `Listen back three times, each time with one job. The first time, listen only to the content: did you say who you are, what you do and why you want to improve? The second time, listen only to the delivery: your speed, your pauses, your volume and any filler words. The third time, listen for what was good. Most people skip the third listen, and then they only remember their faults.`,
          `Keep your notes specific. "I was bad" cannot be fixed. "I said you know about eight times and I rushed the last sentence" can be fixed. A useful note names something you can count, hear or point to. If you can, ask a friend or colleague to listen and tell you one thing that was clear and one thing that was hard to follow. Choose someone kind and honest, not someone who will only praise you or only criticise you.`,
          `A word about feeling embarrassed. Almost every speaker dislikes hearing themselves at first. Treat the feeling as a sign that you are noticing something new, not as a sign that you are bad at this. Your recording is private to you and the reviewers of your account. Nobody else in the course hears it, so you can be honest with yourself.`,
          `Finish by choosing the single thing you want to work on first. One thing is enough. Later in the course you will meet tools for pace, pauses, fillers and structure, and you will return to your note to see whether that one thing has improved.`,
        ], { label: 'Three listening passes', text: `Pass 1, content: Did I say who I am? Did I say what I do? Did I say why I want to improve?
Pass 2, delivery: Was I too fast? Where did I pause? How many times did I say um, you know or basically?
Pass 3, strengths: What sounded natural? Where did I sound most like myself?` }),
        choice('a2', 'checkpoint', 'The purpose of this recording', 'What is the first recording for?', ['To get a score that counts for your certificate', 'To give you a baseline to improve from', 'To be shared with other learners'], 1, 'It is a baseline. A baseline is a starting measurement, so that your final speech has something honest to be compared with. It does not count towards the certificate, and it is private to you and the reviewers of your account. A score is not the point. The point is to hear where you are starting from.'),
      ]),
      lesson('l2', 'Know your audience', 'By the end of this lesson, you can describe an audience and say what they need from you.', 35, [
        teach('t1', 'explanation', 'Three questions', [
          `Before you write a word, ask three questions about your audience: who are they, what do they already know, and what do they need from you. These questions matter more than your topic. The same message about school fees, a new timetable or a health rule must sound different for pupils, for parents and for a board of governors, even though the facts are the same.`,
          `Who are they? Think about age, language and what they are doing when they hear you. Tired parents who arrive after work listen differently from fresh students in the morning. What do they know? Be honest. If you use a word they do not know, such as "stakeholders" or "algorithm", some people will stay silent and quietly stop following you. What do they need? This is the most important question, because people listen hardest to what helps them.`,
          `Your audience is always asking one silent question: what is in this for me? You do not have to say it aloud, but your talk must answer it early. A talk to market traders about mobile payments should begin with the time and money they save, not with how the technology works. Start from their need, and use your topic as the way to meet it.`,
          `A simple habit helps. Before you prepare, complete this sentence: "My audience is ___, they already know ___, and they need ___." If you cannot complete it, you do not yet know your audience well enough, and it is worth a quick conversation with someone who will be there. Ask the organiser, or two people in the group, what they expect to hear.`,
        ], null, { visual: VIS.spAudience, listen: true }),
        teach('t2', 'explanation', 'Size, setting and mood', [
          `Size changes how you speak. In a room of ten people you can be conversational, make eye contact with each person and invite short answers. In a hall of two hundred you need more volume, larger gestures and a structure that people can follow from a distance. A talk that works in a small staff meeting may fall flat in a school hall unless you adjust it.`,
          `Setting and mood matter too. A morning assembly is short and the pupils are standing, so you have about two minutes before attention drops. A church or mosque announcement is heard by people who came for something else, so you must be brief and clear. A wedding reception has noise, music and people who are celebrating, so a warm tone and a light touch work better than statistics. A formal meeting with a chairman expects order, respect for titles and evidence.`,
          `At many Nigerian events, protocol is part of the setting. You greet the chairman, the guests of honour, the elders and the parents, often by title. Honour this, because leaving it out can be taken as disrespect. But keep it to one breath, and save your best energy for what comes right after it, which is your first real sentence. A long list of titles followed by no hook loses the room before you have started.`,
          `Finally, think about mixed audiences. If a head teacher, a driver and a first-year pupil are all listening, do not aim at the cleverest person in the room. Aim at the person who knows least about your topic, and speak clearly enough that they can follow, while giving the experts one fact or example that is worth hearing. Plain words never offend an expert.`,
        ], { label: 'The same news for two audiences', text: `News: The school will start a new way of paying school fees next term.

To parents:
From next term you can pay school fees by bank transfer at any time, day or night. You will no longer need to queue at the school office, and you will receive a receipt on your phone straight away.

To staff:
From next term fees will be paid by bank transfer into one school account. The bursar will reconcile the payments every Friday, and class teachers will receive a list of pupils whose fees are outstanding.` }),
        match('a1', 'guided', 'Match the question to the choice', 'Match each audience question to the choice it helps you make.', [['Who are they?', 'Your words and examples'], ['What do they know?', 'What to skip or explain'], ['What do they need?', 'Where to start']], 'Who they are shapes your words, what they know shapes how much to explain, and what they need shapes your starting point. For example, parents who have not heard about a new timetable need the change explained in simple words, and what they need most is to know what to do on Monday, so that is where you begin.'),
        choice('a2', 'guided', 'Adjust the message', 'You must explain a new school rule to 8-year-olds. What is the best approach?', ['Use the exact words from the rule book', 'Use short sentences and one example from their day', 'Give a long history of the rule'], 1, 'Young listeners need short sentences and concrete examples they recognise. A line such as "When the bell rings, line up at the door like you do for assembly" works better than the exact words of a rule book, because they can picture it. The rule is the same. Only the words change.'),
        teach('t3', 'example', 'A worked example: building an audience sentence', [
          `Here is how one speaker used the three questions. Mrs Okoro teaches Primary 5 and has to explain a new homework rule to parents at a PTA meeting. She first wrote her sentence: "My audience is the parents of Primary 5 pupils. They know that homework exists but they do not know the new rule. They need to know how much time to give each night and what to do if their child is stuck." Then she chose her first line from their need, not from the rule.`,
          `Notice what she left out. She did not explain the research behind homework policies, because the parents had not asked for it. She kept one example, a child who sits for forty minutes and becomes frustrated, and she ended with a clear action: write a short note in the homework book if your child cannot finish. A good audience sentence helps you to cut as well as to choose.`,
          `Before you write your own, check it against three tests. Is it about real people, and not "the public" or "everyone"? Does it say what they do not know, and not only what they know? Is the need something they would agree with if you asked them? If the answer to any of these is no, change the sentence before you write the talk.`,
        ], { label: 'Your audience sentence', text: `My audience is ______.
They already know ______.
They do not yet know ______.
They need ______ from me.` }),
        write('a3', 'attempt', 'Describe your audience', 'Choose a talk you may give soon. In 3 or 4 sentences, say who the audience is, what they already know, and what they need from you.',
          [{ id: 'who', label: 'Says who the audience is.' }, { id: 'know', label: 'Says what they already know or do not know.' }, { id: 'need', label: 'Says what they need from the talk.' }],
          'My audience is the parents of JSS 1 pupils. They know the school but not the new timetable. They need to know what changes for their child and what they must do by Friday.', 'Who, what they know, what they need.'),
      ]),
      lesson('l3', 'Managing nerves', 'By the end of this lesson, you can use a breathing routine and a short preparation habit to feel steadier before speaking.', 30, [
        teach('t1', 'explanation', 'Nerves are normal', [
          `Nearly everyone feels nervous before speaking, including experienced preachers, lecturers and presenters. When you face a group, your body prepares for a challenge. Your heart beats faster, your hands may shake, your mouth becomes dry and your breathing gets short. This is your body releasing adrenaline, a chemical that gives you energy. It is not a sign that you will fail.`,
          `You cannot remove this energy, but you can use it. Some studies of performers have found that people who describe their nervousness as excitement tend to perform better than people who tell themselves to calm down. The two feelings are almost the same in the body, and excitement points you towards the task instead of away from it. Say quietly before you begin: I am ready, and this energy is for my audience.`,
          `Preparation is your strongest tool. The more clearly you know your opening, your main points and your closing line, the less there is to fear. You do not need to memorise a whole speech. In fact, memorising every word makes you more nervous, because one forgotten word can make you freeze. Know your first sentence and your last sentence almost by heart, and know the order of the points in between.`,
          `A slow breathing pattern helps the body settle. Breathe in through your nose for 4 counts, hold gently for 2, then breathe out slowly for 6. Repeat three times. The long breath out tells your body that there is no danger. If you feel dizzy, stop and breathe normally. Practise the pattern at home on an ordinary day, so that it feels familiar when you need it.`,
        ], null, { visual: VIS.spBreath, listen: true }),
        teach('t2', 'explanation', 'A preparation routine that works', [
          `Calm on the day begins days before. Rehearse out loud, standing up, at least three times. Reading your notes silently in your head is not rehearsal, because your mouth has not practised the words. Time yourself once so that you know the talk fits. If you can, rehearse in the room where you will speak, or in a room like it, so that the space does not surprise you.`,
          `Arrive early. Ten to fifteen minutes before you speak, walk to the place where you will stand, check the microphone if there is one, see where the screen and the door are, and look at the seats from the front. Many nerves come from the unknown, and every thing you check is one unknown less. Keep a small bottle of water close, and sip a little before you start so that your mouth is not dry.`,
          `In the last few minutes, do something physical. Unclench your jaw, roll your shoulders back and down, and stand tall with your feet apart. Shake out your hands. Say your opening once, quietly, to yourself. Then find one friendly face in the room that is smiling at you. Friendly faces are almost always there, and finding one early gives you a person to speak to.`,
          `Avoid two common traps. The first is a heavy meal or a very fizzy drink just before speaking, which can make you uncomfortable. The second is last-minute cramming, which makes your mind noisy. If you need to read something, read your opening and your closing line, and then stop.`,
        ], { label: 'A ten-minute countdown', text: `10 minutes: Walk to the speaking spot. Check the microphone, the screen and your notes.
7 minutes: Sip water. Unclench your jaw and drop your shoulders.
5 minutes: Breathe in for 4, hold for 2, out for 6. Do it three times.
2 minutes: Say your opening quietly once. Stand tall.
1 minute: Find one friendly face. Smile, then begin.` }),
        order('a1', 'guided', 'The breathing routine', 'Put the breathing routine in order.', ['In through the nose for 4 counts', 'Hold gently for 2 counts', 'Out slowly for 6 counts', 'Repeat three times'], 'In for 4, hold for 2, out for 6, then repeat three times. The long breath out is the part that calms the body, so do not rush it. If you feel dizzy at any point, stop and breathe normally.', { hints: ['Start with the breath in.'] }),
        choice('a2', 'guided', 'Best preparation', 'Which habit does the most to reduce nerves in the first minute?', ['Memorising every word', 'Knowing your opening very well', 'Avoiding looking at anyone'], 1, 'If you know your opening well, you start strongly and the rest follows, because the first minute is when nerves are highest. Memorising every word is risky: if you forget one, you can lose the whole line and freeze. Know your opening and your last line almost by heart, and know the order of your points.'),
        teach('t3', 'explanation', 'Getting through the first minute', [
          `The first minute is when nerves are strongest, and also when they fall fastest if you let them. Walk to your place at a normal pace. Stop, plant your feet and take one breath before you say a word. That silent second feels long to you and looks confident to everyone else. Then say your opening slowly, because nerves make us speed up.`,
          `Speak to people, not to the room. Choose one person, finish a full thought to that person, then move to someone else. This turns a frightening crowd into a series of small conversations. If your hands shake, hold your notes lightly, or rest one hand on the lectern, but do not grip hard, because then your whole arm will tremble. Most of the audience will not notice shaking that feels huge to you.`,
          `If you make a mistake, do not apologise and do not explain. Pause, correct the word if it matters, and carry on. Audiences judge you by how you recover, not by whether you slip. Many fine speakers stumble and nobody remembers it. What people remember is that you stayed with them.`,
          `You can also give yourself a calm sentence to hold on to. It should be short, true and in your own words. Say it quietly before you begin, and again in the pause after your first line if you need it. You will practise one in the next activity.`,
        ], { label: 'Some calm sentences to choose from', text: `I know my opening, and I will begin slowly.
These people want to hear me, and I have something useful to say.
I will pause, breathe and speak to one person at a time.` }),
        speakTask('a3', 'attempt', 'Say your calm sentence', 'Choose a calm sentence you can say to yourself. Read this one aloud slowly, then say it in your own words.', 'I have prepared well, and I will take my time.', { lang: 'en-NG' }),
        write('a4', 'checkpoint', 'Your routine', 'Write your own pre-talk routine in 3 or 4 sentences. Include breathing and one other thing you will do.',
          [{ id: 'breath', label: 'Includes a breathing step.' }, { id: 'other', label: 'Includes at least one other practical step, such as knowing the opening or checking the room.' }],
          'Ten minutes before, I will check the room and my slides. Then I will breathe in for four counts and out for six, three times. I will say my opening to myself once.', 'A breathing step and one practical step.'),
      ]),
    ]),
    section('s2', 'Opening and structure', 'Start well, organise your ideas and finish clearly.', [
      lesson('l1', 'Opening a talk', 'By the end of this lesson, you can open a talk with a hook that names the topic in under 20 seconds.', 35, [
        teach('t1', 'explanation', 'The first 20 seconds', [
          `Your audience decides quickly whether to listen. In the first twenty seconds they ask themselves two questions: is this worth my attention, and what is this about? A strong opening answers both. It gives them a reason to care and it tells them where the talk is going. A weak opening wastes the moment when attention is highest.`,
          `Five openings work well. A surprising fact makes people sit up: "Every year, our school loses about forty hours of teaching time to paper registers." A direct question makes them think about their own lives: "When did you last wake up truly rested?" A short story pulls them in: "Last month a customer called me at midnight, and she was right to." A bold statement gets attention: "Most arguments at work begin with a message that was never clear." A picture in words places them inside your topic: "Imagine you are standing at the bus stop at six in the morning and the rain begins."`,
          `Avoid three openings. The first is the apology: "Sorry, I am not very good at this." It makes people watch for mistakes instead of listening. The second is the announcement: "Today I will be talking about..." It tells them nothing that the programme did not already say. The third is the long warm-up, such as a minute of thanks. At formal Nigerian events you do need to acknowledge the chairman and the guests, so keep that to one breath, then go straight to your hook.`,
          `Your opening must also name the topic. A hook with no topic leaves people curious but lost, and a topic with no hook leaves them bored. Put them together: hook first, then one sentence that says what the talk is about and what they will gain. Practise your opening more than any other part of the talk. If you start well, the nerves ease and the rest follows.`,
        ], { label: 'Example', text: `Every year, our school loses about 40 hours of teaching time to paper registers. Today I will show you how to get those hours back.` }, { visual: VIS.spOpenings, listen: true }),
        teach('t2', 'explanation', 'Building an opening in three moves', [
          `Use three moves, in this order. Move one is the hook: one or two sentences that make people want to listen. Move two is the topic: one sentence that says clearly what the talk is about. Move three is the promise: a short statement of what the audience will gain by listening. The whole opening should take fifteen to twenty seconds, which is about forty to fifty words at a comfortable pace.`,
          `Make the hook specific. "Many people waste time" is vague and forgettable. "If you spend ten minutes a day looking for your keys, that is more than sixty hours in a year" is specific, and numbers and names stick in the mind. If you use a fact, be sure that it is true and that you can say where it came from. An invented number damages your credibility the moment someone checks it.`,
          `Test your opening on one person. Say it to a friend and ask: what do you think the talk is about, and do you want to hear more? If the answer to the first question is wrong, your topic sentence needs work. If the answer to the second is no, your hook needs work. It is much easier to repair twenty seconds than a whole talk.`,
          `Also match the opening to the occasion. A story suits a warm, small audience. A surprising fact suits a professional meeting. A question suits a class that is awake and willing to think. A bold statement suits a debate or a motivational talk. The best opening is the one that fits these particular people at this particular moment.`,
        ], { label: 'Three openings for the same topic', text: `Topic: why students should use a revision timetable.

Question hook:
How many hours did you waste last week deciding what to study? Most of us cannot say. In the next three minutes I will show you how a simple timetable gives those hours back.

Fact hook:
Most students feel that they study for hours, but few have ever written down what they studied. This talk is about a one-page revision timetable and three habits that make it work.

Story hook:
Last term my friend wrote a timetable on the back of an exercise book. By Friday she had finished three subjects, while I was still deciding where to begin. This talk is about that timetable.` }),
        choice('a1', 'guided', 'Spot the weak opening', 'Which opening is weakest?', ['Sorry, I am a bit nervous, so please bear with me.', 'How many hours did you waste in meetings this week?', 'Last month a customer called me at midnight, and she was right to.'], 0, 'An apology makes people watch for mistakes instead of listening. You may feel humble, but the audience hears a warning that the talk will be poor. A question and a short story both do the opposite: they invite people in, one by thinking about their own experience and the other by creating curiosity.', { why: { 1: 'A question makes the audience think about their own experience.', 2: 'A short story creates curiosity.' }, hints: ['One opening gives the audience a reason to doubt you.'] }),
        teach('t3', 'example', 'Weak openings made strong', [
          `Here are three weak openings and how to repair them. Look at what changes each time, because the repairs follow a pattern: the apology is removed, the vague words become specific, and the audience appears in the first sentence.`,
          `Notice that the stronger openings are not longer. They are more specific. Also notice the pause in the last example. Instead of filling the silence with "um, so, hi", the speaker takes one calm breath. Silence before the first word is a strength, not a weakness.`,
          `The facts in these examples are invented for practice. In a real talk, use only facts that you can check. Now try to write your own opening, and use the three moves: hook, topic and promise.`,
        ], { label: 'Before and after', text: `Before: Good morning everyone, sorry, I am a bit nervous, so please bear with me. Today I want to talk about road safety.
After: Last Tuesday, a pupil from our school was almost knocked down crossing the road outside our gate. Today I will show you four rules that can stop it happening again.

Before: Today I will be talking about keeping our things in order.
After: If you spend ten minutes a day looking for your keys, that is more than sixty hours in a year. Here is how to get them back.

Before: Um, so, hi everyone, I guess I will start now.
After: [Pause for one breath.] Every evening, homework decides whether our children rest or worry. Tonight, I will show you how to make it calmer.` }),
        write('a2', 'attempt', 'Write your opening', 'Write an opening of two or three sentences for a 3-minute talk to your class about why people should sleep eight hours. Use a surprising fact, a question or a short story. Do not apologise.',
          [{ id: 'hook', label: 'Begins with a hook: a fact, a question or a short story.' }, { id: 'topic', label: 'Makes clear that the talk is about sleep.' }, { id: 'noapology', label: 'Contains no apology and does not begin with "Today I will be talking about".' }],
          'When did you last wake up feeling truly rested? Most of us cannot remember, and it is costing our marks. In the next three minutes, I will show you why eight hours matters.', 'A hook first, then the topic, with no apology.', { hints: ['Try starting with a question about the last time they felt tired.'] }),
        speakTask('a3', 'independent', 'Say it aloud', 'Read this opening aloud. Then say your own opening from the last task aloud, without reading.', 'When did you last wake up feeling truly rested? Most of us cannot remember.', { mode: 'read', lang: 'en-NG' }),
        choice('a4', 'checkpoint', 'Choose the stronger opening', 'You will speak about saving money. Which opening is strongest?', ['Today I will be talking about saving money.', 'If you saved just \u20a65,000 a month, you would have \u20a660,000 in a year. Here is how.', 'Um, so, hi everyone, I guess I will start now.'], 1, 'It gives a concrete benefit, with a real number the listener can picture, and it promises how with the words "Here is how". Together these answer the two questions every listener has in the first twenty seconds: why should I care, and what happens next? Naming the topic alone does neither.', { why: { 0: 'It names the topic but gives no reason to care.', 2: 'Filler words and hesitation weaken the opening.' }, hints: ['Look for a specific number and a promise.'] }),
      ], 2),
      lesson('l2', 'Structure: open, body, close', 'By the end of this lesson, you can organise a short talk into an opening, three points and a close.', 40, [
        teach('t1', 'explanation', 'A talk in three parts', [
          `Tell them where you are going, take them there, and then remind them where you arrived. This old advice is the simplest map of a talk. Every talk has an opening, a body and a close, and each part has a job. A listener who cannot find the shape of your talk will stop trying to follow it.`,
          `The opening has three jobs: a hook to win attention, a topic sentence to say what the talk is about, and a preview to tell the audience how it is organised, for example "I will give you three reasons." The body carries your points, usually two or three, each with proof or an example. The close has three jobs: a short summary, a call to action, and a final line that people can remember.`,
          `Keep to three points for a short talk. Three is large enough to feel complete and small enough to remember. If you have six good points, group them into three themes, or choose the three that matter most to this audience and drop the rest. Cutting is a kindness to your listeners. A talk that covers three points well beats a talk that touches ten and leaves everyone tired.`,
          `Give each point the same simple shape: state the point, support it, link it to the audience. "A school garden teaches science" is the point. A short example, such as a pupil who waters bean seeds every morning for two weeks and sees them become plants, is the support. "So the biology lesson becomes something pupils have seen with their own eyes" is the link. When every point has this shape, the talk feels steady and easy to follow.`,
        ], null, { visual: VIS.spStructure, listen: true }),
        teach('t2', 'explanation', 'Planning the time and the words', [
          `Plan your talk by time. At a comfortable pace most people speak about 120 to 160 words per minute, so a three-minute talk is roughly 360 to 480 words, including pauses. A common split is fifteen per cent for the opening, seventy per cent for the body and fifteen per cent for the close. For a three-minute talk that is about thirty seconds, two minutes and thirty seconds.`,
          `Plan to finish a little early. Talks almost always run longer on the day than in rehearsal, because of greetings, laughter and the slower pace that nerves can force on you. If you are given five minutes, prepare for four. Organisers, especially at school events, church programmes and weddings where many people speak, will thank you, and the audience will remember you as a speaker who respects their time.`,
          `Write the structure before the words. On a single page, write the opening in one line, each point in one line, and the close in one line. If you cannot say your talk in five lines, you are not ready to write it in full. Once the five lines are clear, add one example under each point, and practise from the five lines instead of from a full script. Speaking from an outline sounds more natural than reading.`,
          `Finally, remember that the close deserves real preparation. Many speakers plan their opening and body carefully and then end with "so, yeah, that is all, thank you". Plan your last two sentences word for word. The call to action should be small, specific and possible: "This week, bring one empty tin to class and we will plant the first seeds on Friday" is better than "Let us all care more about nature".`,
        ], { label: 'A five-line outline', text: `Topic: Why our school should start a small garden (3 minutes)
Opening: Ask who has ever planted anything, then promise three reasons.
Point 1: A garden teaches science (example: watching bean seeds grow).
Point 2: A garden gives fresh food (example: vegetables for the canteen).
Point 3: A garden teaches responsibility (example: pupils taking turns to water).
Close: Summarise the three reasons, then ask: bring one empty tin this week.` }),
        order('a1', 'guided', 'Order the talk', 'Put the parts of a talk in order.', ['Hook', 'Topic and preview', 'Point 1 with example', 'Point 2 with example', 'Summary and call to action'], 'Hook, topic and preview first, then the points with their examples, then the close. This order follows how listeners think: first they need a reason to listen, then a map, then the content, and finally a clear ending. Each part prepares the audience for the next.'),
        choice('a2', 'guided', 'The call to action', 'What is a call to action?', ['A summary of every point', 'A clear thing you want the audience to do next', 'A joke at the end'], 1, 'It tells the audience what to do with what they heard. A talk without one can be pleasant and still change nothing. The best calls to action are small, specific and possible, such as "Tonight, read for twenty minutes", because people can do them straight away.'),
        teach('t3', 'example', 'A short talk, marked up', [
          `Here is a complete one-minute talk with its parts labelled in square brackets. The labels are for you, and the speaker does not say them aloud. Read it slowly and look for the hook, the preview, the three points and the call to action.`,
          `Notice four things. The hook asks the audience to do something with their hands, so they are involved at once. The preview says "three reasons", so the listeners know how long they must follow. The signposts "first", "second" and "third" are short and clear. The close repeats the three reasons in a few words and ends with one small action that can be done that same week.`,
          `Now it is your turn. In the next activity you will outline a talk of your own, with one line for the opening, three lines for the points, and one line for the close. Keep each line short. You are planning, not writing a speech.`,
        ], { label: 'A one-minute talk, marked up', text: `[Hook] Put your hand up if you have ever planted anything. Keep it up if it grew.
[Topic] I want to talk about starting a small garden at our school.
[Preview] I will give you three reasons it is worth the effort.
[Point 1] First, a garden teaches science. When you water a bean seed every morning, you see for yourself what the textbook only describes.
[Point 2] Second, a garden gives food. Even a few beds of vegetables can supply the canteen with something fresh every week.
[Point 3] Third, a garden teaches responsibility. Plants die if nobody waters them, so every pupil on the rota matters.
[Close] So, three reasons: science, food and responsibility. This week, bring one empty tin to class, and on Friday we plant the first seeds.` }),
        write('a3', 'attempt', 'Outline a talk', 'Outline a 3-minute talk on why pupils should read for 20 minutes a day. Write one line for the opening, three lines for the points, and one line for the close.',
          [{ id: 'open', label: 'Has an opening line with a hook or topic.' }, { id: 'points', label: 'Has three distinct points.' }, { id: 'close', label: 'Has a closing line that includes a call to action.' }],
          'Opening: A question about the last book they finished. Point 1: reading improves vocabulary. Point 2: it improves concentration. Point 3: it is free at the library. Close: pick a book tonight and read for 20 minutes.', 'An opening, three points, and a close with an action.', { minWords: 25 }),
      ]),
      lesson('l3', 'Signposting and one clear message', 'By the end of this lesson, you can state one main message and use signposts to guide listeners.', 30, [
        teach('t1', 'explanation', 'One message, clear signs', [
          `A good talk has one main message that you can say in one sentence. Everything else supports that sentence. The message is not the topic. "Road safety" is a topic. "Four simple rules keep our pupils safe on the road outside our gate" is a message, because it says something that can be agreed or disagreed with. Ask yourself: after my talk, what one sentence should the audience carry home?`,
          `Use the message to decide what to keep. For every point, example and story, ask: does this support my one message? If it does, keep it. If it is interesting but does not support the message, cut it, or save it for another talk. This feels painful because we like our good material, but listeners remember one clear idea far better than five scattered ones.`,
          `Signposts are short phrases that tell listeners where they are in the talk. When you read, you can look back at the page. When you listen, you cannot, so the audience depends on your signposts to find the thread again after a distraction, a phone buzz or a moment of thinking about lunch. Without signposts, even a well-organised talk feels like a heap.`,
          `There are four useful kinds. Sequence signposts show order: "first", "the second reason", "finally". Contrast signposts show a turn: "but", "on the other hand". Emphasis signposts mark what matters: "if you remember one thing today, remember this". Summary signposts pull things together: "so, to sum up". Use plain, natural words, and say them clearly with a short pause before and after, so that they stand out.`,
        ], null),
        teach('t2', 'explanation', 'Saying the message and the signs aloud', [
          `Say your message twice: once near the start and once at the end, in nearly the same words. Repetition is not boring in speech, because listeners cannot re-read. A good pattern is to state the message in the opening, link every point back to it, and end with it again. Many speakers use the same short phrase each time, such as "Four rules, one safe school".`,
          `Use an internal summary after a long point: "So we have seen that reading builds vocabulary. Now, the second reason." It takes five seconds and resets the audience's attention. Use a preview before a new section: "Now I will show you how to do it, in three steps." Summaries and previews are the ropes that hold a talk together.`,
          `Do not overuse one phrase. A speaker who begins every sentence with "so", "anyway" or "you see" is not signposting, only filling space. Test each phrase by asking: does this tell the listener where we are or where we are going? If it does not, it is a filler, and silence would serve you better.`,
          `Speak your signposts with a little more weight than the words around them. Slow down slightly on "the second reason", pause for a moment, and then give the reason. Your voice is the underline. If you rush through a signpost, the listener may miss it, and then it cannot help them.`,
        ], { label: 'A message with its signposts', text: `Message: Four simple rules keep our pupils safe on the road outside our gate.
Opening: Last Tuesday a pupil was almost knocked down outside our gate. Today I will give you four rules that stop that happening.
Sequence: The first rule is to stop at the kerb. The second rule is to look both ways, twice. The third rule is to walk, never run.
Contrast: Those three are easy. But the fourth rule is the one people forget.
Emphasis: If you remember only one rule today, remember this one: hold the hand of any younger child.
Close: So, four rules, one safe school. Stop, look both ways, walk, and hold a hand.` }),
        choice('a1', 'guided', 'Find the signpost', 'Which phrase is a signpost?', ['Um, so basically', 'The second reason is cost', 'Anyway'], 1, 'It tells listeners which point they are on. A signpost carries information about where the talk is. "Um, so basically" and "Anyway" carry none, so they only fill space. When you listen for signposts in other speakers, you will notice how much easier the talk is to follow.'),
        fill('a2', 'guided', 'Complete the signpost', 'Type the missing word: "Let me ___ with a story." (to end the talk)', ['finish', 'close', 'end', 'conclude'], 'Finish, close, end and conclude all signal that the close is coming. This matters because listeners relax and then focus when they know the end is near, and your last words stay with them. Use one of these phrases before your closing summary and call to action, and then keep to your word and finish soon.', { hints: ['It means the talk is about to end.'] }),
        teach('t3', 'example', 'Finding and testing your message', [
          `To find your message, finish this sentence: "After my talk, I want the audience to believe, know or do ___." Believe, know and do are three different goals. If you want them to believe something, your talk needs reasons. If you want them to know something, it needs clear explanation. If you want them to do something, it needs a specific request. Choose one goal for each talk.`,
          `Then test the message. Can you say it in fifteen words or fewer? Could someone disagree with it, which shows that it says something? Would your audience care? A message like "Exams are important" fails the second test, because nobody will disagree. "Starting revision three weeks early beats two nights of panic" passes it.`,
          `When you write your own message in the next activity, include two signpost phrases that you would really say. Choose plain ones, such as "The first benefit is health" or "My second reason is cost". Do not choose words that sound grand. The best signposts are the ones that you can say without thinking.`,
        ], { label: 'Weak and strong messages', text: `Weak: Exams are important.
Strong: Starting revision three weeks early beats two nights of panic.

Weak: Technology in schools.
Strong: A tablet can replace a heavy bag only if every pupil can charge it at home.

Weak: Our company culture.
Strong: People work better when mistakes can be reported without fear.` }),
        write('a3', 'attempt', 'Your main message', 'Write the main message of a talk you could give, in one sentence. Then write two signpost phrases you would use.',
          [{ id: 'msg', label: 'States one main message in one sentence.' }, { id: 'sign', label: 'Includes two signpost phrases.' }],
          'Main message: Walking to school every day makes pupils healthier and more focused. Signposts: "The first benefit is health" and "My second reason is focus".', 'One message and two signposts.', { minWords: 15 }),
      ]),
    ]),
    section('s3', 'Voice and body', 'Use pace, pauses, volume, pitch and posture on purpose.', [
      lesson('l1', 'Four dials of the voice', 'By the end of this lesson, you can name the four voice dials and choose settings for a message.', 30, [
        teach('t1', 'explanation', 'Pace, volume, pitch and pause', [
          `Your voice has four dials. Pace is how fast you speak. Volume is how loud you are. Pitch is how high or low your voice sounds. Pause is the silence between your ideas. A speaker who changes these dials on purpose is easy and pleasant to follow. A speaker who stays on one setting, even a good one, sends listeners to sleep, because the brain stops paying attention to anything that never changes.`,
          `Think of the dials as tools for meaning. Slow down for numbers, names and the key idea, because the listener needs time to take them in. Speed up a little for a lively example or for background. Speak louder to show energy or to reach the back row, and lower your volume slightly to draw people in when you say something personal. Let your pitch rise at a question and fall at the end of a firm statement, which sounds like certainty.`,
          `Many speakers fall into a flat pitch when they are nervous or reading. The remedy is to speak to a real person and to mean what you say. If you care about a sentence, your pitch will move on its own. Reading aloud from a page is harder than speaking from an outline, because reading flattens the voice, so use short notes instead of a full script when you can.`,
          `Volume deserves special attention. Speak as if you want the person at the very back to hear you comfortably, not as if you are shouting. Breathe low in the body, from the belly, and keep your head level so that the voice is not squeezed. Finish your sentences with the same energy that you began with. Many people let the last two or three words fall away, and those words are often the most important ones.`,
        ], null, { visual: VIS.spVoice, listen: true }),
        teach('t2', 'explanation', 'Clarity, stress and the microphone', [
          `The dials are no use if the words cannot be understood. Clarity comes from saying each word fully, especially the ends of words. Open your mouth a little more than you do in casual talk. Slow down on long or unfamiliar words, such as the names of people and places. If your accent differs from that of your listeners, you do not have to change it. You only have to be clear, and clarity comes from careful, complete words, not from sounding foreign.`,
          `Stress is the extra weight you place on certain words, and it changes meaning. The sentence "I did not say he stole the money" can carry several different meanings, depending on which word you lean on. Before you speak, underline the one or two words in each sentence that carry your meaning, and give them a little more weight, length or volume. Let small words like "of" and "the" pass quickly, and stress the words that matter.`,
          `If you use a microphone, treat it with respect. Hold it or place it about the width of a hand from your mouth, pointing at your chin. Keep that distance steady, because moving the microphone makes the volume jump. Do not tap it or blow into it. Stand behind the loudspeakers, not in front of them, so that the sound does not return to the microphone as a whistle. If it whistles, step back, turn your head slightly away and ask the technician calmly for help, then carry on.`,
          `Warm up your voice before you speak. Yawn to open your throat, hum gently, and say a tongue twister slowly and then a little faster, such as "red lorry, yellow lorry". Sip water at room temperature. Do not shout or strain your voice beforehand. If you speak often, rest your voice when you can, because a tired voice is flatter and quieter.`,
        ], { label: 'The same sentence, different stress', text: `I did NOT say he stole the money. (I deny that I said it.)
I did not say HE stole the money. (Someone else may have.)
I did not say he STOLE the money. (Perhaps he borrowed it, or took it by mistake.)
I did not say he stole THE money. (Perhaps he stole something else.)` }),
        match('a1', 'guided', 'Match the dial', 'Match each voice dial to what it controls.', [['Pace', 'How fast you speak'], ['Volume', 'How loud you are'], ['Pitch', 'How high or low you sound'], ['Pause', 'The silence between ideas']], 'Each dial is separate, so you can change one without changing the others. For example, you can slow your pace and keep your volume high, or lower your volume and keep your pace steady. Skilled speakers move the dials one at a time to match the meaning of each sentence.'),
        choice('a2', 'guided', 'Which dial?', 'You are about to say an important number. Which change helps most?', ['Speak faster', 'Slow down and pause after it', 'Speak more quietly'], 1, 'Slowing down and pausing gives listeners time to take the number in. Numbers are hard to hear, because each one has to be understood, remembered and compared. If you speed through a number, the listener is still thinking about it while you move on, and they lose the next sentence as well.'),
        teach('t3', 'example', 'Practising the dials before you record', [
          `Try this drill before you record. Read one short paragraph from any book or newspaper three times. The first time, read it as flat as you can. The second time, exaggerate: slow down on the key words, change your pitch a great deal, and use loud and soft. The third time, keep about half of the exaggeration. The third version is usually the best natural delivery, and the exaggeration shows your voice how much range it really has.`,
          `For your recording, you will describe a journey that you know well, for example the road to school or work, or a trip to the market. Plan one detail that you will mark as important, such as the slowest part of the road. Slow down for that detail, pause after it, and let your voice drop slightly. Keep your other details a little quicker and lighter, so that the important one stands out.`,
          `Cognita measures your pace in words per minute. It counts the words in your transcript and divides them by the length of the whole recording, so silence at the start and end counts against you. Begin within a second of pressing record and stop soon after your last word. A pace between 100 and 180 words per minute passes, and most people are comfortable around 120 to 160.`,
        ], { label: 'A plan for your recording', text: `1. Where the journey starts and how I travel.
2. Two details I notice on the way.
3. One IMPORTANT detail: slow down, pause after it.
4. How I feel when I arrive.` }),
        assignment('a3', 'attempt', 'Record with varied pace', {
          format: 'audio', review: 'auto', certRequired: false, minSeconds: 30, maxSeconds: 90, maxAttempts: 3,
          prompt: 'Record yourself for 30 to 60 seconds describing your journey to school or work. Slow down for one important detail and speak clearly.',
          rubric: [{ id: 'journey', label: 'Describes a journey with at least two details.' }, { id: 'detail', label: 'Gives one detail that is clearly marked as important.' }],
          metricRules: [PACE], checklist: ['Speak at a steady pace', 'Slow down for the important detail'],
        }),
      ]),
      lesson('l2', 'Pace and pauses', 'By the end of this lesson, you can use pauses to give ideas room and replace filler words with silence.', 35, [
        teach('t1', 'explanation', 'Silence is part of the sound', [
          `Silence is part of speaking. A pause is not a hole in your talk. It is part of the message. A short pause of about one second lets you breathe and find the next phrase. A longer pause of two or three seconds, right after your most important sentence, lets it land. Pauses feel very long to you because you are listening to your own heartbeat. To the audience they feel natural, and often wise.`,
          `There are three kinds of pause. The breath pause comes at the end of a phrase or sentence, usually where a comma or a full stop would be, and lets you breathe. The thought pause comes before an important word or idea and tells the audience that something important is coming. The landing pause comes after a key sentence and gives the audience time to take it in. Use all three on purpose.`,
          `Pace is the other half. A comfortable pace for most listeners is roughly 120 to 160 words per minute. Nerves usually push people faster, sometimes above 200, and then listeners lose words. If you do not know your pace, measure it. Read a passage of 150 words aloud with a timer. If it takes one minute, you are at 150 words per minute. If it takes forty-five seconds, you are at 200, which is too fast for most audiences.`,
          `A pace that never changes is as tiring as a voice that never changes. Slow down for key ideas and numbers, and speed up slightly for background and for stories. The aim is not to speak slowly all the time. The aim is to choose your speed, so that the audience feels guided and not hurried.`,
        ], null, { visual: VIS.spPause, listen: true }),
        teach('t2', 'explanation', 'Where to pause, and what to do in the silence', [
          `Mark your pauses in your notes. Draw a single slash after a phrase where you will pause briefly, and a double slash after a sentence that you want to land. Reading aloud with marked pauses is the fastest way to learn how they feel, and you will find that the silence is shorter than you feared.`,
          `Pause after a question and let the audience think. A speaker who asks "How many of you have ever lost a phone?" and continues at once is not asking, only talking. Count silently to two or three. Pause before a number or a name that matters, and after it. Pause when you move from one point to the next. It tells the audience that a new section has begun, like a paragraph break in writing.`,
          `What do you do during a pause? Breathe, look at one person, and keep your face and body relaxed. Do not smile nervously, look at the floor or say "um". If a silence feels too long, count one, two in your head. Nearly all speakers pause too little and almost never too much. A slightly long pause makes the audience think that you are thinking. A very long pause can simply be ended by saying your next sentence.`,
          `Pauses also help you manage your pace. When you notice yourself speeding up, add a pause at the next full stop and drop your pitch a little. The speed falls back by itself. If you rush at the start, which is common, plan a pause after your opening line, and take a breath before the main body begins.`,
        ], { label: 'Marked pauses', text: `The bridge was closed. //
For three weeks. //
Nobody told us why. //
So we waited / and we walked / and we learned / to leave the house an hour earlier. //` }),
        speakTask('a1', 'guided', 'Read with pauses', 'Read this aloud. Pause for one second at each slash.', 'We lost forty hours. / Every single year. / Here is how we fix it.', { mode: 'read', lang: 'en-NG' }),
        choice('a2', 'guided', 'Where to pause', 'Where is the best place for a long pause?', ['In the middle of a word', 'Right after your most important sentence', 'Before every sentence'], 1, 'A pause after the key idea gives it time to land. This is the landing pause. Pausing in the middle of a word breaks the sound, and pausing before every sentence makes the talk feel slow. Use your longest pause only for the one or two ideas that you most want people to keep.'),
        teach('t3', 'explanation', 'Recording with pauses: what Cognita measures', [
          `In the next task you will record a talk of 45 to 90 seconds on one habit that helps you study or work, and you will use at least two deliberate pauses after key ideas. Cognita transcribes your recording and measures two things: your pace and your filler words. The rules for this task are a pace between 100 and 180 words per minute and no more than six filler words in every hundred words.`,
          `Pace is worked out by counting the words in your transcript and dividing them by the length of the whole recording. That means silence counts. If you wait ten seconds before you begin, or leave a long gap at the end, your measured pace falls. Press record, begin within a second, and stop soon after your last word. Deliberate pauses of one to three seconds are fine, but a recording full of very long gaps may drop below 100.`,
          `Plan the habit before you record. Choose one habit that really helps you, decide on one reason it helps and one example from your own life, and mark two places where you will pause: after you name the habit, and after you give the reason. Rehearse once aloud, then record. If your first attempt is too fast, slow down on the key phrases, not on every word.`,
        ], { label: 'A pause plan', text: `Habit: The habit I want to talk about is ___. //
Reason: It helps me because ___. //
Example: Last week, ___. //
Close: One short line that sums it up.` }),
        assignment('a3', 'attempt', 'Record a paced talk', {
          format: 'audio', review: 'auto', certRequired: true, minSeconds: 45, maxSeconds: 120, maxAttempts: 4,
          prompt: 'Record a 45 to 90 second talk on one habit that helps you study or work. Use at least two deliberate pauses after key ideas.',
          rubric: [{ id: 'habit', label: 'Talks about one clear habit.' }, { id: 'reason', label: 'Gives a reason or example for why it helps.' }],
          metricRules: [PACE, FILL(6)], checklist: ['Pause after key ideas', 'Replace "um" with silence'],
        }),
      ]),
      lesson('l3', 'Body language', 'By the end of this lesson, you can describe four simple habits of posture, eyes, hands and feet.', 30, [
        teach('t1', 'explanation', 'Simple habits, no acting', [
          `Your body speaks while you do. It sends the audience a message about how confident, honest and interested you are, and when your words and your body disagree, people tend to believe the body. You do not need to act or to copy anyone. You need a few simple habits that help your body support your message instead of fighting it.`,
          `Start with your eyes. Look at one person for one whole thought, then move to another person, and keep moving around the room: left, right, front, back. Do not sweep across faces quickly, and do not stare at the wall, the floor or your notes. Eye contact tells each person that you are speaking to them. If you are nervous, begin with the friendliest face and let that person give you confidence.`,
          `Next, your stance and shoulders. Stand with your feet about shoulder width apart, your weight even on both feet, your shoulders relaxed and down, your head level and your chest open. Breathe low in the belly. This posture helps your voice, because a collapsed chest squeezes the breath, and it looks calm. Avoid swaying, rocking, crossing your legs and standing on one leg, because these movements distract more than you expect.`,
          `Then your hands and movement. Let your hands rest at waist height when you are not using them, and use them to show size, number or order: hands apart for "big", fingers for "three reasons", one hand moving forward for "next". Do not hide them in your pockets, grip them tightly or fiddle with a pen. Move on purpose, for example one step to the side when you begin a new point, and stay still when you make a key statement. Tap the numbered points on the picture to see each habit.`,
        ], null, { visual: VIS.spBody }),
        teach('t2', 'explanation', 'Adjusting your body to the situation', [
          `Different places need different habits. Behind a lectern, stand a little back so that the audience can see your upper body, and keep your hands free instead of gripping the sides. With a handheld microphone, keep one arm bent and steady and use your free hand for gestures. If you are seated at a table, sit tall, lean slightly forward and rest your forearms on the table, so that you do not slump or hide.`,
          `On camera, the rules change. The viewer sees only your face and hands, so keep your gestures inside the frame, at chest height. Look at the camera lens when you speak, not at your own face on the screen, because looking at the lens is what feels like eye contact to the viewer. Hold the phone at eye height, steady against a stack of books or a wall. A phone held at chest height looks up your nose and shakes with every breath.`,
          `Also think about respect and culture. In many Nigerian settings, how you carry yourself shows respect: a small nod or a light bow of the head when you greet elders, and a courteous manner towards dignitaries. Long, fixed eye contact with a much older person can feel impolite in some communities. A warm, steady look that moves around the room, with a nod to the elders when you acknowledge them, shows respect and still connects you with everyone. Know your audience, as the first lesson taught.`,
          `Finally, smile when the content invites it. A smile at the start, and at warm or hopeful moments, tells the audience that you are glad to be there. Do not hold a smile when the topic is serious or sad, because it will look odd. Let your face match your words. When your face and your voice agree, your listeners relax.`,
        ], { label: 'A quick body check before you begin', text: `Feet: shoulder width apart, weight even.
Knees: soft, not locked.
Shoulders: relaxed and down.
Hands: resting at waist height.
Face: relaxed, ready to smile.
Eyes: find one friendly face.` }),
        match('a1', 'guided', 'Match the habit', 'Match each part of the body to a good habit.', [['Eyes', 'Hold contact for a whole thought'], ['Shoulders', 'Relaxed and open'], ['Hands', 'Rest at waist height, gesture with meaning'], ['Feet', 'Steady, shoulder width apart']], 'Each habit helps you look calm and look at your audience. Eyes hold a whole thought so that each person feels spoken to. Relaxed shoulders keep your breath free. Hands at waist height are ready to gesture with meaning. Steady feet stop the swaying that distracts the audience.'),
        choice('a2', 'guided', 'Fix the habit', 'A speaker keeps swaying from side to side. What is the best fix?', ['Hold a pen tightly', 'Plant both feet and move only when starting a new point', 'Look at the floor'], 1, 'A steady stance stops swaying, and moving on purpose looks confident. Swaying is usually a nervous habit, and the audience watches it instead of listening. Plant both feet while you speak, and take a step only when you begin a new point, so that every movement carries meaning.'),
        teach('t3', 'explanation', 'Recording your short video', [
          `In the next task you will record a video of 20 to 45 seconds in which you introduce yourself. A reviewer, who is a person, will watch it and give you one note on eye contact and one on posture or gesture. The video is stored privately, and it is not marked by a machine. The reviewer wants to see that you are visible, that you are audible, and that you are speaking to the camera.`,
          `Prepare the set before you record. Put a window or a lamp in front of you, not behind you, so that your face is lit. A bright window behind you turns you into a dark shape. Check the background and remove clutter. Prop the phone at eye height and about an arm's length away, so that your head and shoulders fill the frame. Charge the phone first, because a power cut or a low battery will end the recording halfway.`,
          `Then rehearse once without recording. Say your name, what you do and one thing you enjoy, in about thirty seconds. Look at the lens, relax your shoulders, keep your hands at waist height and speak slowly. Watch the first take. Check three things: can you see your whole face, can you hear every word, and do you look like you are talking to a person? Fix one thing, then record again.`,
        ], { label: 'Video checklist', text: `Light: the main light is in front of me.
Sound: I am in a quiet place and I can hear myself clearly.
Frame: head and shoulders fill the screen, phone at eye height.
Eyes: I look at the lens, not at the screen.
Body: shoulders relaxed, hands at waist height, weight even.
Voice: I speak slowly and finish every sentence.` }),
        assignment('a3', 'attempt', 'Record a short video', {
          format: 'video', review: 'admin', certRequired: false, minSeconds: 20, maxSeconds: 60, maxAttempts: 3,
          prompt: 'Record a video of 20 to 45 seconds in which you introduce yourself while standing or sitting up straight. A reviewer will watch it and give you one note on eye contact and posture.',
          rubric: [], metricRules: [], checklist: ['Look at the camera lens, not the screen', 'Keep your shoulders relaxed', 'Hold the phone steady at eye height'],
          reviewGuide: 'Watch the video. Give one note on eye contact and one on posture or gesture. Approve if the learner is visible, audible and speaking to the camera.',
        }),
      ]),
      lesson('l4', 'Filler words', 'By the end of this lesson, you can name common filler words and replace them with a pause.', 30, [
        teach('t1', 'explanation', 'Um, like, you know', [
          `Filler words are the small sounds and words that we use to fill silence while we think. Some are sounds, such as um, uh and er. Some are words, such as like, you know, basically, actually, sort of and kind of. Some are short phrases, such as "you see", "as in" or "I mean", and some are ordinary words used too often, such as beginning every sentence with "so". A few fillers are normal in conversation. Many make a speaker sound unsure and distract the listener from the message.`,
          `Why do we use them? Because silence feels dangerous. When we are thinking, nervous, or afraid that someone will interrupt, we fill the gap to keep hold of the floor. Most fillers are habits that we pick up from the people around us, and we cannot hear our own. That is why recordings are so useful. Many speakers are shocked to find that they say "you know" or "basically" every few sentences.`,
          `The cure is not to try harder to avoid them. When you tell yourself "do not say um", your attention goes to the word and you often say it more. The cure is a replacement: a silent pause. A pause costs nothing, it gives you time to think, and the audience hears it as confidence. Nobody notices a pause in the way that they notice an "um". Every filler that you replace with silence makes you sound more prepared.`,
          `Do not aim for zero. Even skilled speakers say a few. Aim to reduce them to a level where the listener does not notice. In this course the targets for recorded tasks are between four and six fillers in every hundred words, depending on the task, and your final speech asks for no more than four.`,
        ], null),
        teach('t2', 'explanation', 'How to catch and reduce fillers', [
          `First, catch them. Record yourself for one minute and play it back with a pen and paper, making a mark each time you hear a filler. Count the words roughly, then work out how many fillers you say in every hundred words. For example, six fillers in a recording of 150 words is 4 in every hundred (6 divided by 150, times 100). Cognita does this sum for you, but doing it once by hand teaches you to listen.`,
          `It helps to know what Cognita counts. It looks in the transcript of your recording for um, erm and er, uh and ah, the word like, you know, basically, actually, and sort of or kind of. Two honest warnings follow. First, the counter cannot tell a filler from a real use, so it counts "like" even in "I like football". In a recorded task, choose other words, such as "enjoy" or "such as", where you can. Second, automatic transcription can miss a soft "um", so treat the count as a minimum and listen to your own recording as well.`,
          `Then reduce fillers with four habits. Slow down, because most fillers come from speaking faster than you can think. Speak in shorter sentences, because every long sentence has more places to get lost. Know your transitions, so that moving from one point to the next is prepared, for example "Now, the second reason." And replace the sound with a breath: close your mouth, breathe in through your nose, and say the next word. Practise one habit at a time for a few days.`,
          `When you catch yourself in the middle of a filler, do not apologise or react. Finish the sentence, pause, and carry on. If a filler slips out, the audience will forget it. If you stop to scold yourself, they will remember that. And be patient: most people need several weeks of recording and listening before a habit that took years to form begins to loosen.`,
        ], { label: 'Counting fillers', text: `Transcript (38 words):
So, um, today I want to talk about, you know, our school library. Basically, it is open every break, and, um, like, pupils can borrow a book for a week. Actually, it is the best place to study.

Counted fillers: um, you know, basically, um, like, actually = 6
Rate: 6 fillers in 38 words is about 16 in every hundred. The target is 4 to 6.
Note: starting with "so" is also a filler habit, but Cognita does not count it. Listen for it yourself.` }),
        choice('a1', 'guided', 'Which is a filler?', 'Which of these is a filler word?', ['Therefore', 'Basically', 'Tomorrow'], 1, 'Basically is often used as a filler that adds nothing. Therefore and tomorrow carry real meaning in a sentence, while basically only fills the space where a pause could be. If you can remove a word and the sentence means exactly the same, it is probably a filler.'),
        choice('a2', 'guided', 'The best fix', 'What is the best way to reduce fillers?', ['Speak faster so there is no time for them', 'Pause silently instead', 'Never stop speaking'], 1, 'A silent pause replaces the filler and gives you thinking time. Speaking faster leaves less time to think, so it usually creates more fillers, and never stopping is impossible for any speaker. A pause is the only fix that gives you what the filler was trying to give you, which is a moment to find your next words.'),
        teach('t3', 'example', 'From filler-heavy to clean', [
          `Here is the same message said twice. The first version is full of fillers. The second keeps the meaning and replaces each filler with a silent pause or a firmer sentence. Notice that the second version is not slower in total, only calmer, and that every sentence is complete.`,
          `For the next task, prepare a short answer to the question about your school or workplace. Choose your point and one reason before you press record. Use this shape: the answer first, then the reason, then one example. When you feel a filler coming, close your mouth and breathe in. The silence may feel very long to you, but when you listen back it sounds calm and natural.`,
          `Keep in mind the length. The task asks for 45 to 90 seconds. At a steady pace that is roughly 90 to 220 words. Write only three key words on a card, not a script, so that you speak from your head and not from a page. Then record, listen once for content and once for fillers, and record again if you need to. You have several attempts.`,
        ], { label: 'Before and after', text: `Before:
So, um, I just wanted to, you know, tell you that, basically, the bus will, like, leave at seven tomorrow, um, instead of half past seven, actually.

After:
Tomorrow the bus will leave at seven, not half past seven. // Please be at the gate by ten to seven.` }),
        assignment('a3', 'attempt', 'Record a low-filler answer', {
          format: 'audio', review: 'auto', certRequired: true, minSeconds: 45, maxSeconds: 120, maxAttempts: 4,
          prompt: 'Record a 45 to 90 second answer to this question: "What is one thing you would like people to know about your school or workplace?" Pause instead of using fillers.',
          rubric: [{ id: 'answer', label: 'Gives one clear thing about the school or workplace.' }, { id: 'support', label: 'Supports it with a reason or example.' }],
          metricRules: [PACE, FILL(4)], checklist: ['Pause instead of saying um', 'Keep a steady pace'],
        }),
      ]),
    ]),
    section('s4', 'Craft your content', 'Stories, persuasion and slides.', [
      lesson('l1', 'Stories', 'By the end of this lesson, you can tell a short story in five beats to make a point.', 35, [
        teach('t1', 'explanation', 'A story in five beats', [
          `A short story makes a point memorable. Facts are quickly forgotten, but a well-chosen story stays in the mind, because listeners picture it, feel it and remember what happened to the people in it. This is why teachers, preachers and market traders have always used stories. A story does not replace your point. It carries your point into the listener's memory.`,
          `Use five beats. The situation sets the scene: who, where and when, in a sentence or two. The problem tells what went wrong or what was difficult. The turning point is the moment when something changed: a decision, a piece of advice or a discovery. The result shows what happened afterwards. The lesson says what it means, and it is the reason you told the story at all.`,
          `Keep it short. In a three-minute talk a story should take about thirty seconds, which is roughly 70 to 80 words. Start late and end early: begin as close to the problem as you can, and stop soon after the result. Leave out details that do not serve the point, such as what day it was or who else was there, unless they make the picture clearer.`,
          `Always tie the story back to your point. Say what it means for the audience, in a sentence that they can repeat. A story that ends without a lesson leaves each listener to guess, and many will guess something else. And keep to the truth. You may change names to protect people, but do not invent facts and present them as real, because audiences can often tell and you will lose their trust.`,
        ], null, { visual: VIS.spStory, listen: true }),
        teach('t2', 'explanation', 'Making a story vivid and honest', [
          `Specific details make a story real. "A woman came to my shop" is forgettable. "A woman in a green wrapper came to my shop at closing time with a crying baby" is a picture. Choose one or two details that the listener can see or hear, such as a colour, a sound, a number, or a few words that someone said. Details are small, so they cost few words and bring great value.`,
          `Use speech when you can. Instead of "My teacher told me to be careful", say what she said: "Be careful, she told me. One mistake in this job and the whole batch is gone." The actual words make listeners lean in, because they can hear the person. Let your voice give each speaker a slightly different sound, but do not over-act. A small change in pace and pitch is enough.`,
          `Where do stories come from? Your own life is the best source: a mistake, a first day, a person who helped you, a moment when you were afraid, a lesson from a parent, a trader or a teacher. Keep a small notebook, or the notes on your phone, and write down any moment that surprised you. After a month you will have material for many talks. For each one, ask: what point could this story make?`,
          `Choose the story to fit the point and the audience. A story about a business that failed suits a talk on planning. A story about helping a neighbour suits a talk on community. Check that the story is fair: does it embarrass someone, share a secret or hurt anyone? If so, change it or choose another. And practise telling it aloud, because a story that reads well on paper can sound long when it is spoken.`,
        ], { label: 'A story in five beats, marked up', text: `[Situation] In my first week as a class teacher, I walked into a room of forty pupils with no plan.
[Problem] Within ten minutes half the class was talking, and I could not be heard.
[Turning point] That evening an older teacher told me, "Give them something to do in the first two minutes."
[Result] The next day I wrote three questions on the board, and the class settled before I spoke a word.
[Lesson] So when you lead any group, begin with a task, not a speech.` }),
        order('a1', 'guided', 'Order the beats', 'Put the story beats in order.', ['Situation', 'Problem', 'Turning point', 'Result', 'Lesson'], 'Set the scene, add the problem, show the change, show the result, then give the lesson. This order matches how listeners follow a story: they need to know the situation before the problem matters, and they need the problem before the turning point means anything. The lesson comes last because it is the reason for the whole story.'),
        teach('t3', 'example', 'Choosing, shaping and telling your story', [
          `Choose a story in which you learned something, because the activity asks for a lesson. It does not need to be dramatic. A small moment is often best: a conversation, a mistake at work, a journey that went wrong. Ask yourself what you understand now that you did not understand before, and tell the story that taught you.`,
          `Write it in four to six sentences, one beat at a time, using the planning sheet below. Then read it back and cut. Remove any sentence that does not move the story from one beat to the next. Check that there is a clear problem, a moment when things changed, and a lesson that speaks to the audience and not only to you. "I learned to plan" is about you. "So when you have a deadline, finish a day early" speaks to them.`,
          `Later you will tell the story aloud without reading. Use the beats as a map: remember the five words, not the sentences. Pause briefly before the turning point, so that the change lands, and slow down a little for the lesson. Tell it as if to one friend. Cognita will transcribe your telling, check that it has a problem, a change and a lesson, and check that your pace stays between 100 and 180 words per minute.`,
        ], { label: 'Story planning sheet', text: `Situation: ______ (who, where, when)
Problem: ______ (what went wrong or was hard)
Turning point: ______ (what changed things)
Result: ______ (what happened next)
Lesson: So when you ______, ______. (speak to the audience)` }),
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
      lesson('l2', 'Persuasion', 'By the end of this lesson, you can use credibility, emotion and logic to support a message.', 35, [
        teach('t1', 'explanation', 'Three ways to persuade', [
          `Persuasion does not mean tricking people. It means giving them good reasons, in a way they can feel and trust, so that they choose to agree or to act. More than two thousand years ago the Greek thinker Aristotle described three appeals that still work: ethos, pathos and logos. We can call them credibility, emotion and logic. Strong talks use all three, and each one answers a different doubt in the listener's mind.`,
          `Credibility, or ethos, answers "why should I listen to you?" You build it with your experience, your preparation and your honesty. Say briefly what qualifies you, name your sources, and admit what you do not know. A short sentence is enough: "I have taught this class for eight years." Credibility is also built by how you speak: clear, calm, well prepared and respectful of the audience's time.`,
          `Emotion, or pathos, answers "why should I care?" People act when they feel something, not only when they understand. A real example of one person helps listeners feel why the issue matters. "Last rainy season, Mama Tunde's shop was flooded and she lost her stock" moves people more than a statistic does. Use emotion honestly, with real people and real events, and never use fear or guilt to push people into something that is not true.`,
          `Logic, or logos, answers "why is it true, and why is this the right thing to do?" Give clear reasons, numbers and examples, and connect them in order: because of this, therefore that. Check your facts. Strong persuasion also deals with objections: say the best reason against your idea, and answer it fairly. And do not exaggerate. Audiences notice, and exaggeration costs you the trust that credibility has built.`,
        ], null, { visual: VIS.spPersuade }),
        teach('t2', 'explanation', 'From persuasion to a request', [
          `Persuasion is useful only if it leads to something. After you have built credibility, feeling and logic, make a clear request, which is the call to action. Make it specific, small and possible: who should do what, and by when. "Please support the clean-up" is vague. "Please bring a broom or a shovel to the junction at seven on Saturday morning" is a request that people can say yes to.`,
          `Prepare for objections. Think of the three strongest reasons that someone might say no, such as cost, time or doubt that it will work, and answer them inside your talk before anyone asks. "Some of you will say that we have no money for this. The tools cost nothing, because each family will bring its own." Answering an objection early shows that you respect the audience and that you have thought carefully.`,
          `Use the rule of three, a simple pattern that sounds complete: three reasons, three examples or three short phrases in a row, such as "faster, cheaper and safer". Use contrast too: "We can pay now for a small repair, or pay later for a big disaster." And end on your strongest point, not on your weakest. Arrange your reasons so that the last one is the one that you want the audience to remember.`,
          `Finally, be fair. Attack ideas, never people. Do not twist what others have said, and do not use a statistic that you cannot explain. If you are not sure of a fact, say so, or leave it out. Honest persuasion lasts longer, because people who feel respected are willing to listen to you again. Dishonest persuasion may win today and cost you your reputation for years.`,
        ], { label: 'Three appeals for one request', text: `Request: Ask neighbours to clear the drains on Saturday before the rains.

Credibility: I have lived on this street for twelve years, and I organised the clean-up two years ago.
Emotion: In the last flood, Mama Tunde's shop was covered in water and she lost her stock.
Logic: Blocked drains make the water back up into the road and the homes beside it, and clearing them takes one morning.
Objection answered: Some of you will say that clearing drains is the council's job. It is, and we will report it too, but the rain will not wait for the council.
Call to action: Please bring a broom or a shovel to the junction at seven on Saturday morning.` }),
        match('a1', 'guided', 'Match the appeal', 'Match each appeal to the question it answers.', [['Credibility', 'Why listen to you?'], ['Emotion', 'Why should I care?'], ['Logic', 'Why is it true?']], 'Each appeal answers a different doubt. Credibility answers "why should I trust you?", emotion answers "why does this matter to me?", and logic answers "is this actually true?" A talk that has only one of them leaves the other doubts open, and listeners who still have a doubt rarely act.'),
        choice('a2', 'guided', 'Which appeal?', '"Last year I trained 200 teachers in this method." Which appeal is this?', ['Credibility', 'Emotion', 'Logic'], 0, 'It shows experience, which builds credibility. Training 200 teachers is evidence that the speaker knows the subject. It is not an emotional story, because it has no one person in it, and it is not a reason, because it does not explain why the method works. Notice that a short, specific claim like this one does the job in a single sentence.'),
        teach('t3', 'example', 'Writing one sentence for each appeal', [
          `In the next task you will write three sentences, one for each appeal, to support a request. Take them one at a time. For credibility, say something true about your experience or your preparation: what you have done, seen, read or measured. For emotion, tell a small true moment about one person, with a detail that the listener can picture. For logic, give a reason that follows from a fact, with a number if you have one.`,
          `Check each sentence against its question. Does the first answer "why listen to you?" Does the second answer "why should I care?" Does the third answer "why is this true?" A common mistake is to write three sentences of logic, because logic feels safest. Another is to use emotion with no real person in it, such as "Think of the children". Name a real situation instead.`,
        ], { label: 'Weak and strong, for a request to buy fans for a classroom', text: `Request: The school should buy ceiling fans for Primary 4.

Credibility, weak: I know a lot about schools.
Credibility, strong: I have taught Primary 4 for six years, and I have sat in that room at noon.
Emotion, weak: Think of the children.
Emotion, strong: Last Tuesday, Ada put her head on her desk at eleven o'clock and could not finish her sums.
Logic, weak: Fans are good.
Logic, strong: A pupil who is too hot cannot concentrate, so lessons after eleven are wasted without a fan.` }),
        write('a3', 'attempt', 'Use all three', 'You want your school to start a reading club. Write three sentences: one that builds credibility, one that uses emotion, and one that uses logic.',
          [{ id: 'cred', label: 'Includes a sentence that builds credibility.' }, { id: 'emo', label: 'Includes a sentence that appeals to feeling with an example.' }, { id: 'logic', label: 'Includes a sentence with a reason or fact.' }],
          'I have run a reading club at my church for two years. One pupil told me it was the first book she ever finished. Pupils who read 20 minutes a day usually gain vocabulary faster.', 'One sentence for each appeal.', { minWords: 20 }),
      ]),
      lesson('l3', 'Slides that help', 'By the end of this lesson, you can say what makes a slide help or hurt a talk.', 30, [
        teach('t1', 'explanation', 'Support, do not replace', [
          `A slide is a tool for the eyes, and your voice is a tool for the ears. When both carry the same words, the audience has to read and listen at once, and people cannot do both well. They read the slide, finish before you do, and then stop listening. That is why a slide full of text makes people lose you.`,
          `Put one idea on each slide: one number, one picture, one short phrase or one simple diagram. If you need a sentence to explain it, say it aloud. The slide gives people something to see while you give them the reason to care. A good test is whether a person at the back of the room can read and understand the slide in three seconds.`,
          `Size and contrast matter. Use text of at least 24 points, and larger if the hall is big. Use dark text on a light background or light text on a dark background, and avoid colours that are hard to tell apart, such as yellow on white or red on green. Keep to one or two plain fonts. If a room has strong daylight, light backgrounds are usually easier to read than dark ones.`,
          `Use pictures that mean something and not just decoration. A photo of the real problem, a simple chart with one clear message or a screenshot of the new tool does more than clip art. If you show a chart, give it a title that states the finding, for example "Absences fell by half after term one", and remove everything that is not needed. Do not read your slides aloud, and do not turn your back to look at the screen. Glance at it to check, then face the audience again.`,
        ], null, { visual: VIS.spSlides }),
        teach('t2', 'explanation', 'Preparing for the room, the power and the unexpected', [
          `Plan for what can go wrong, especially in places where the power and the internet are not always reliable. Save your slides on the laptop, on a flash drive and on your phone, and send a copy to yourself by email. Do not depend on Wi-Fi to open the presentation, and do not rely on a video that needs the internet. Ask the organiser in advance what equipment will be there: the projector, the type of cable, and the sound.`,
          `Charge the laptop and carry the charger. Find out whether the venue has a generator or other backup, and how long the switch-over takes. Know your talk well enough to give it without slides. Prepare a one-page summary on paper, with your five-line outline, so that if the projector fails or the power goes off you can continue calmly. Audiences admire a speaker who carries on with grace, and a power cut can even be a chance to speak straight to the people.`,
          `Learn a few simple controls. In PowerPoint's slide show, pressing the B key turns the screen black and pressing it again brings the slide back, which pulls attention to you when you want to talk without a slide. Check that your speaker notes are not shown on the screen that the audience sees. Put a timer or a watch where you can see it. Stand beside the screen, not in front of the projector beam, so that the light does not fall on your face.`,
          `Finally, keep a plain backup. Export a PDF copy of your slides as well. A PDF opens almost anywhere and keeps your layout. If you share your slides afterwards, send the PDF and not the editable file, so that your fonts and pictures do not change on someone else's computer.`,
        ], { label: 'A checklist before you go', text: `Files: slides on the laptop, a flash drive and my phone. PDF copy saved.
Power: laptop charged, charger packed, a plan if the power goes off.
Notes: one-page outline on paper.
Equipment: projector, cable and sound checked with the organiser.
Slide basics: one idea per slide, large text, no reading aloud.` }),
        choice('a1', 'guided', 'Better slide', 'Which slide is better for a talk?', ['Seven bullet points of full sentences', 'One large number with a few words', 'A paragraph copied from a report'], 1, 'One idea, big and clear, lets the audience listen. A single large number can be understood in a moment, and then the audience turns back to you for the explanation. Seven bullet points or a copied paragraph ask people to read, and while they read they cannot follow what you say.'),
        choice('a2', 'guided', 'Reading slides', 'Why should you not read your slides aloud?', ['It takes too long', 'People can read faster than you speak, so you add nothing', 'It is against the rules'], 1, 'The audience reads ahead and stops listening to you. People read faster than you speak, so by the time you reach the second line they have finished the slide and are waiting. Your voice then adds nothing new, and attention drifts. Use the slide for the picture or number, and use your voice for the explanation.'),
        teach('t3', 'example', 'Planning three slides', [
          `In the next task you will plan three slides. You do not need to make them. For each slide, write the single idea and what you would show. Begin by writing your three points as short phrases, then ask for each: what is the one thing that I want people to see, and what would help them to see it? Choose a number, a picture, a short phrase or a very simple diagram.`,
          `Check each slide with three questions. Can it be understood in three seconds? Does it carry one idea only? Does it help the listener, or does it only comfort me because it holds my notes? If the slide is really your notes, move the words to your own card and leave the slide for the audience.`,
        ], { label: 'A three-slide plan for a talk on keeping business records', text: `Slide 1: Idea: without records, you cannot see your profit. Show: a large question mark and the word "Profit?"
Slide 2: Idea: a simple notebook is enough to start. Show: a photo of one notebook page, sales on the left and costs on the right.
Slide 3: Idea: the call to action. Show: the single word "Tonight" in large letters, with a small picture of a pen.` }),
        write('a3', 'attempt', 'Plan three slides', 'Plan three slides for a talk on a topic you know. For each slide write the single idea and what you would show (a number, a picture or a few words).',
          [{ id: 'three', label: 'Describes three slides.' }, { id: 'one', label: 'Each slide has a single idea.' }, { id: 'show', label: 'Says what is shown on each slide, not a block of text.' }],
          'Slide 1: 40 hours lost, shown as the number 40. Slide 2: the old register, shown as a photo. Slide 3: the new app, shown as a screenshot with the word Faster.', 'Three slides, one idea each.', { minWords: 25 }),
      ]),
    ]),
    section('s5', 'Delivering with confidence', 'Questions, practice and your final speech.', [
      lesson('l1', 'Handling questions', 'By the end of this lesson, you can follow a five-step routine when someone asks a question.', 30, [
        teach('t1', 'explanation', 'A routine for questions', [
          `Questions can frighten speakers, because you cannot prepare the exact words. But a question is also a sign that someone was listening and cares. A calm routine turns a frightening moment into a conversation. The routine has five short steps, and the more you practise it, the more automatic it becomes: listen, pause, repeat, answer, check.`,
          `Listen to the whole question. Do not start your answer while the person is still speaking, and do not guess where the sentence is going. Look at the person and nod slightly. Then pause for a breath. The pause gives you a moment to think, and it shows that the question deserves a thoughtful reply. A two-second pause feels long to you and looks calm to everyone else.`,
          `Repeat the question briefly, in your own words, for the whole room. In a large hall many people could not hear it, and repeating it also gives you more time and lets you put the question in its fairest form: "The question is whether the new rule means more work at home." Then answer. Give the answer first, then one reason, and then stop. "Yes, a little, about fifteen minutes a night, because the tasks are shorter but daily." Finally, check that you answered it: look at the person, or ask "Does that answer your question?"`,
          `If you do not know, say so plainly: "I do not know, but I will find out and tell you by Friday." Then do it. Honesty builds more trust than a confident guess that turns out to be wrong. If a question is outside your topic, say so politely and offer to talk afterwards. If someone is rude or angry, stay calm, thank them for the question and answer the part that is fair. Never argue back or mock the questioner, because the audience will judge you by how you treat people.`,
        ], null, { visual: VIS.spQa, listen: true }),
        teach('t2', 'explanation', 'Kinds of questions and how to prepare for them', [
          `Not all questions are alike. Friendly questions are easy: answer them well and briefly. Unclear questions need a check: "Do you mean the cost for this term or for the whole year?" Long questions with several parts can be split: "You asked three things. Let me take the first one now and come back to the others." Off-topic questions can be parked: "That is a good question and I want to give it proper time, so please find me after the meeting."`,
          `A hostile question may hide a real concern. Take a breath, keep your voice level, and find the true question inside the anger: "I hear that you are worried about the cost." Acknowledge the feeling before you answer, and keep your answer to facts. You do not have to win. You only have to be fair, calm and clear, and the audience will see that.`,
          `Prepare for questions before every talk. Write down the five questions that you most expect and the one that you hope nobody asks, and prepare a short answer to each, so that none of them surprises you. When you invite questions, say "What questions do you have?" and not "Are there any questions?" The first assumes that people have questions and makes it easier to speak. And wait. Count silently to five before you decide that nobody has a question, because someone often raises a hand after a pause.`,
          `Do not let the last question be your last word. Question time can end on a weak or an angry note, so tell the audience that you will take one more question, answer it, and then close with a short line of your own, such as your main message and your call to action again. The last words should be yours, and they should be the words that you most want people to remember.`,
        ], { label: 'The routine in action', text: `Parent: Will this new homework rule add more work for my child?

Pause. Repeat: The question is whether the new rule means more work at home.
Answer first: A little, about fifteen minutes a night.
One reason: The tasks are shorter, but they come every day, so children practise more often.
Check: Does that answer your concern?
If you do not know: I do not have the exact figure for Primary 6, but I will check with their teacher and tell you by Friday.` }),
        order('a1', 'guided', 'Order the routine', 'Put the five steps in order.', ['Listen', 'Pause', 'Repeat the question', 'Answer', 'Check'], 'Listen, pause, repeat, answer, check. Listening comes first because an answer to the wrong question is worse than no answer. The pause gives you time to think, and repeating the question helps the whole room and gives you a little more time. Answer and then check so that you know the person was satisfied.'),
        choice('a2', 'guided', 'You do not know', 'Someone asks something you cannot answer. What is best?', ['Make something up', 'Say you do not know and how you will find out', 'Change the subject'], 1, 'Honesty builds trust, and offering to find out shows you take the question seriously. A made-up answer may be caught later and damages everything else you said, and changing the subject tells people you have something to hide. Say that you do not know, say when you will find out, and then keep your promise.'),
        teach('t3', 'example', 'Recording your answer', [
          `In the next task you imagine a listener who asks: "Why should I spend my time on this?" Choose a real topic first, for example a talk, a project or a habit that you could speak about. Then record an answer of 20 to 60 seconds. The task is marked on two things: that you give the answer before the reasons, and that you give at least one clear reason.`,
          `Use this shape: answer, reason, stop. Begin with the answer in one sentence. Then give one reason, and one short example if you have time. Then stop. Do not add "so yeah" or "that is all". The silence after your last word is part of a strong ending.`,
          `Watch your measurements too. Cognita checks that your pace stays between 100 and 180 words per minute and that you use no more than five filler words in every hundred. Two or three attempts are normal, and each time you can listen to the recording and fix one thing.`,
        ], { label: 'The shape of a good short answer', text: `Answer: one sentence that says yes, no or what you recommend.
Reason: one sentence that says why.
Example: one short sentence (optional).
Stop: say nothing more.` }),
        assignment('a3', 'attempt', 'Answer a question aloud', {
          format: 'audio', review: 'auto', certRequired: true, minSeconds: 20, maxSeconds: 90, maxAttempts: 4,
          prompt: 'Imagine a listener asks: "Why should I spend my time on this?" Record a 20 to 60 second answer. Give the answer first, then one reason.',
          rubric: [{ id: 'first', label: 'Gives the answer before the reasons.' }, { id: 'reason', label: 'Gives at least one clear reason.' }],
          metricRules: [PACE, FILL(5)], checklist: ['Answer first', 'One reason', 'Stop'],
        }),
      ]),
      lesson('l2', 'The practice loop', 'By the end of this lesson, you can run a feedback loop to improve one thing at a time.', 30, [
        teach('t1', 'explanation', 'Record, listen, fix one thing', [
          `Improvement comes from small, repeated cycles, not from one long rehearsal. The cycle has four steps. Record yourself. Listen back. Pick one fix. Speak it again. Then repeat. Three short rounds in one day teach you more than one long run-through, because each round tests whether your fix worked.`,
          `When you listen back, listen twice. The first time, listen for content: is the message clear, are the points in order, does the opening hook, and does the close ask for something? The second time, listen for delivery: pace, pauses, volume, filler words and anything odd in your voice. Write what you hear in specific words. "Fast in the second point, about twenty seconds early" is useful. "Not good" is not.`,
          `Choose only one fix per round. Trying to fix five things at once usually fixes none, because your attention cannot hold five targets while you are also finding your words. Choose the fix that will help your audience most. If you are not sure, start with the biggest of these: the opening, the pace, the filler words. Fix one, check that it worked, and then take the next.`,
          `Look for outside help too. Ask one honest listener to watch you once, and ask two questions: what was clear, and what lost you? Do not defend yourself while they answer. Write down what they say and thank them. If nobody is available, record yourself and leave the recording for a day. A day later you hear it more like a stranger would.`,
        ], null, { visual: VIS.spFeedback }),
        teach('t2', 'explanation', 'Planning your rehearsal week', [
          `Plan backwards from the day you will speak. Four or five days before, build the outline and write the opening and the closing lines in full. Three days before, rehearse out loud, standing, with a timer, and record one round. Two days before, listen back, choose one fix and do two more rounds. The day before, do one run-through in the venue or in a similar space, and then stop. Rest is part of preparation.`,
          `Rehearse in the conditions that you will face. If you will stand, stand. If you will use a microphone, practise holding a bottle at the right distance from your mouth. If there will be slides, practise with them, and practise once without them in case the power fails. If you will speak after other people, practise sitting and listening for a while, then standing up and starting with your hook, because that moment is the hardest in real life.`,
          `Keep a small log. After each round, write one line: what you tried and what you noticed. After a week you will see progress that you cannot feel from the inside, and you will see which fix made the biggest difference. The log also helps on bad days, because it reminds you that you have improved before.`,
          `Be patient and kind to yourself. Skills of the voice and the body change slowly. You may feel worse on the second day because you notice more, and this usually means that your listening is improving. Keep going. People who record and review a few minutes each day for two or three weeks usually notice a clear change.`,
        ], { label: 'A practice log', text: `Round 1: Too fast in the second point. Fix: pause after each point.
Round 2: Pauses are better, but the opening felt weak. Fix: start with the story.
Round 3: The opening is stronger. Two "you know" in the close. Fix: breathe before the last sentence.` }),
        order('a1', 'guided', 'Order the loop', 'Put the loop in order.', ['Record yourself', 'Listen back', 'Pick one fix', 'Speak it again'], 'Record, listen, choose one fix, speak again. The order matters: you cannot choose a useful fix until you have listened, and you cannot know the fix worked until you speak again. Keeping to one fix per round stops you from being overwhelmed.'),
        teach('t3', 'example', 'Writing your practice plan', [
          `In the next activity you will write your practice plan for the final speech. Keep it short and real, in three or four sentences: when you will practise, how many rounds you will do, and the one fix that you will start with. A plan that names days and a number is far more likely to happen than a plan that says "I will practise a lot".`,
          `Choose your first fix from your own recordings, not from this lesson. Which of these would hurt a listener most: a weak opening, a rushed pace, many filler words, no pauses, or no clear call to action? Pick the one that you heard most clearly in your own voice. Also decide how you will know that the fix worked, for example "fewer than five filler words in the next recording".`,
        ], { label: 'A planning frame', text: `When: I will practise on ___ and ___.
Rounds: I will record ___ rounds each time.
First fix: The one thing I will work on first is ___.
How I will know: In the next recording, I will check ___.` }),
        write('a2', 'attempt', 'Plan your practice', 'Write your practice plan for the final speech in 3 or 4 sentences. Say how many rounds you will do and what one fix you will start with.',
          [{ id: 'rounds', label: 'Says how many rounds or when they will practise.' }, { id: 'fix', label: 'Names one specific fix to start with.' }],
          'I will record three rounds this week. My first fix will be pausing instead of saying um. After that I will work on a slower pace in the opening.', 'Rounds and one fix.'),
      ]),
      lesson('l3', 'Final assessment', 'By the end of this assessment, you can show that you know the main ideas of the course. You need 75% to pass.', 30, [
        teach('t1', 'introduction', 'Before you begin', [
          `This is the final assessment. It has eight questions on the main ideas of the course. You need to answer at least six of the eight correctly, which is 75 per cent. You have three tries on each question. If you use all three tries, the answer is shown and that question does not count towards your result.`,
          `Your tutor can explain what a question is asking, if the wording is not clear, but it will not help you choose an answer. That keeps the result honest, and your certificate depends on it. If you do not reach 75 per cent, you can review the course and take the assessment again, so a poor result is not the end.`,
          `Read each question slowly, and read every option before you choose. Many wrong answers are partly true, so look for the best answer and not only a true one. If you are unsure, think about what the course taught and ask what would help the audience most. Answers that give listeners a clear reason, a clear map, time to think or one clear idea are usually the strong ones.`,
          `Before you begin, check yourself with the list below. If a question on it surprises you, go back to that lesson first. When you are ready, breathe in for four, hold for two, and out for six, and then begin.`,
        ], { label: 'Questions to ask yourself first', text: `Nerves: What helps most in the first minute, and what is the breathing pattern?
Openings: What are the three moves, and which openings should you avoid?
Structure: How many points suit a short talk, and what does a good close contain?
Voice: What are the four dials?
Pauses: Where does a long pause do the most good?
Fillers: What should replace an "um"?
Stories: What are the five beats?
Persuasion: What does each of credibility, emotion and logic answer?
Slides: What should one slide carry?
Questions: In what order do you handle a question?` }),
        choice('f1', 'checkpoint', 'Opening', 'Which opening is best?', ['Sorry, I did not prepare much.', 'Last week a pupil asked me a question I could not answer. Today I will answer it.', 'Today I will be talking about homework.'], 1, 'A short story with a promise gives a reason to listen.', { hints: [] }),
        choice('f2', 'checkpoint', 'Structure', 'How many main points are best for a short talk?', ['One to three', 'Seven to ten', 'As many as you can fit'], 0, 'Three is the most listeners can hold in a short talk.', { hints: [] }),
        choice('f3', 'checkpoint', 'Pause', 'What is the best use of a long pause?', ['After your most important sentence', 'Before every word', 'During a question'], 0, 'It lets the key idea land.', { hints: [] }),
        choice('f4', 'checkpoint', 'Fillers', 'What is the best way to avoid saying "um"?', ['Pause silently', 'Talk faster', 'Whisper'], 0, 'A silent pause replaces the filler.', { hints: [] }),
        choice('f5', 'checkpoint', 'Slides', 'What is the best slide for a key number?', ['One large number with a few words', 'A paragraph', 'A table of twenty numbers'], 0, 'One idea, big and clear.', { hints: [] }),
        match('f6', 'checkpoint', 'Appeals', 'Match each persuasion appeal to what it does.', [['Credibility', 'Shows why to trust you'], ['Emotion', 'Shows why it matters'], ['Logic', 'Shows why it is true']], 'Each answers a different question.', { hints: [] }),
        choice('f7', 'checkpoint', 'Questions', 'What should you do first when someone asks a question?', ['Answer at once', 'Listen to the whole question', 'Disagree'], 1, 'Listen first, then pause.', { hints: [] }),
        choice('f8', 'checkpoint', 'Nerves', 'Which helps most in the first minute?', ['Knowing your opening well', 'Memorising everything', 'Avoiding eye contact'], 0, 'A well-known opening gives a confident start.', { hints: [] }),
      ], 1, { exam: true, threshold: 0.75 }),
      lesson('l4', 'Your final speech', 'By the end of this lesson, you have recorded a final speech for review and you can compare it with your starting point.', 55, [
        teach('t1', 'introduction', 'The final task', [
          `This lesson brings the whole course together. You will give one talk of about two minutes on a topic of your choice, and you will record it twice: first as audio, then on video. The talk should have an opening with a hook, two or three points with at least one example, and a close with a call to action. Afterwards you will compare it with your starting point.`,
          `The audio is marked at once. Cognita transcribes it, measures your pace and filler words, and checks what you said against a list of five things: a hook, a clear topic, at least two points, an example and a call to action. You need at least four of the five, a pace between 100 and 180 words per minute, and no more than four filler words in every hundred. You may try up to five times.`,
          `The video is reviewed by a person. The reviewer watches the whole video and checks that there is a clear opening, at least two points and a close, that you can be heard, and that you look at the camera. If the video meets the standard for a beginner, it is approved. If it does not, the reviewer will tell you the one most useful thing to fix, and you can record again. You can finish the course while the video waits for review, but your certificate is issued only after it is approved.`,
          `Use the practice loop. Do at least two rounds before you submit, and listen back each time. The next two steps help you to choose a topic, plan the talk and prepare for the day of recording.`,
        ], null),
        teach('t2', 'explanation', 'Choosing a topic and planning the talk', [
          `Choose a topic that you know well and care about, so that you can speak without a script. Good topics are practical and have a clear audience: how to prepare for an exam, why a school should keep a library, how to welcome a visitor to your workplace, why a community should keep its street clean, how to start a small business. If you cannot decide in five minutes, choose the topic that you could talk about with a friend for an hour.`,
          `Write one message sentence first, using the form "After my talk, I want my audience to ___." Then plan the three parts, using the times in the planning sheet. For a talk of about two minutes, give the opening about twenty seconds, the body about eighty seconds and the close about twenty seconds. Most people speak at 120 to 160 words per minute, so that is roughly 240 to 320 words in total, and you will speak from five lines of notes and not from a script.`,
          `Check your plan against the five things that Cognita and the reviewer look for. Do you open with a hook? Do you say the topic early? Do you make at least two clear points? Do you support at least one with an example or a short story? Do you close with a call to action that is small, specific and possible? If you can tick all five, you are ready to rehearse.`,
        ], { label: 'A planning sheet for your final speech', text: `Message: After my talk, I want my audience to ______.
Opening (20 seconds): Hook ______. Topic ______. Preview: "I will give you two or three reasons."
Point 1 (about 30 seconds): ______  Example: ______
Point 2 (about 30 seconds): ______  Example: ______
Point 3 (optional, about 20 seconds): ______
Close (20 seconds): Summary ______. Call to action ______. Last line ______.` }),
        teach('t3', 'explanation', 'Rehearsal and recording day', [
          `Rehearse in rounds, as you learned in the practice loop. In round one, speak from your five lines and time yourself. In round two, record the audio, listen back and choose one fix. In round three, record again and compare. Stop when your recording is clearly better than your first one, even if it is not perfect. Perfect is not the standard. A clear, honest beginner talk is.`,
          `On the day, choose a quiet room and a quiet time. Turn off notifications and tell your family that you are recording. Charge your phone, and put your five-line outline in front of you. Sip some water. Do the breathing pattern, say your opening quietly once, and begin within a second of pressing record. Speak to one friend. When you finish your last sentence, wait a second, then stop the recording.`,
          `For the video, give the same talk again and use the video checklist from the lesson on body language: light in front of you, the phone steady at eye height, your head and shoulders in the frame, your eyes on the lens, shoulders relaxed and hands at waist height. Do not try to memorise the audio version word for word. You will say it differently, and that is fine. The reviewer wants to see the same structure in your own natural words.`,
        ], { label: 'Recording day checklist', text: `Quiet room, notifications off, phone charged.
Outline in front of me, water close.
Breathing pattern done, opening said once.
Begin within a second of pressing record.
Audio first. Listen back. Fix one thing. Then record the video.
Video: light in front, phone at eye height, look at the lens.` }),
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
        teach('t4', 'reflection', 'Comparing with your starting point', [
          `The last activity asks you to compare your final speech with your first recording, so listen to both before you write. Hear them one after the other, ideally on the same day. Use your baseline notes from the first lesson: what did you notice then, and what did you plan to work on? Listen for the same things in your final speech.`,
          `Be specific and fair. Name at least one real improvement, with evidence, such as the number of filler words or the steadiness of your pace. Name one thing that is still hard, and say what you will do about it. Avoid both false modesty and false pride. An honest account of your progress is what makes the next stage of learning possible.`,
          `Then look beyond the course. Where will you speak next, and which skill from this course will you use first? Public speaking is a habit that grows with use. Offer to give the vote of thanks, to lead the devotion, to present at the staff meeting or to read at the assembly. Every real talk is another round of the practice loop.`,
        ], { label: 'A frame for your comparison', text: `In my first recording I noticed ______.
In my final speech I noticed ______.
The biggest improvement is ______, and I can hear it when ______.
The next thing I will work on is ______, by ______.` }),
        write('a3', 'reflection', 'Compare with your start', 'Write 4 or 5 sentences comparing your final speech with your starting-point recording. Say what improved and what you will work on next.',
          [{ id: 'improved', label: 'Names something that improved.' }, { id: 'next', label: 'Names something to work on next.' }],
          'My pace is steadier now and I use pauses instead of um. My opening is stronger. Next I want to work on eye contact and on telling the story without notes.', 'What improved and what is next.', { minWords: 25, voice: true }),
      ], 1),
    ]),
  ],
};
