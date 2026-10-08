from lib import *

def sp_openings():
    c = Canvas('Three openings that work', 'Pick one. Say it in under 20 seconds.')
    cards = [('A surprising fact', 'Every year our school loses\n40 hours to paper registers.', 'Makes the audience\nthink: really?'), ('A short question', 'When did you last wake up\nfeeling truly rested?', 'Makes the audience\nthink about themselves.'), ('A one-line story', 'Last month a customer called\nme at midnight. She was right.', 'Makes the audience\nwant the next line.')]
    for i, (h, ex, why) in enumerate(cards):
        x = 60 + i * 370
        c.box(x, 160, 340, 400); c.text(x + 170, 215, h, 26, ACC, 'bold', 'middle')
        c.box(x + 20, 245, 300, 150, ACCSUB, ACCSUB, r=12); c.text(x + 170, 295, ex, 20, INK, 'normal', 'middle')
        c.text(x + 170, 450, why, 20, MUTED, 'normal', 'middle')
        c.badge(i + 1, x + 30, 180, h, ['Use a number or a fact the audience did not expect. Check that it is true and say where it comes from.', 'A question works when the audience can answer it silently in their head. Pause for one second after you ask.', 'A story opening is one sentence, not a paragraph. Say who, what happened, and stop.'][i])
    c.pill(60, 590, 1080, 56, 'Avoid: an apology, or "Today I am going to talk about..."', OKSUB.replace('e3eee9', 'f7ece9'), '#b3423a', 24)
    return c

def sp_structure():
    c = Canvas('A talk in three parts', 'Tell them where you are going, go there, then say where you arrived.')
    c.box(60, 160, 320, 420, ACCSUB, ACC); c.text(220, 210, 'Opening', 30, ACC, 'bold', 'middle')
    c.text(220, 280, '1  Hook\n2  Topic\n3  Preview', 24, INK, 'normal', 'middle')
    c.text(220, 450, 'about 10 percent\nof the time', 20, MUTED, 'normal', 'middle')
    c.box(440, 160, 320, 420, CARD); c.text(600, 210, 'Body', 30, ACC, 'bold', 'middle')
    for i in range(3):
        c.box(470, 245 + i * 90, 260, 70, ACCSUB, ACC2, r=12); c.text(600, 288 + i * 90, f'Point {i + 1} + proof', 22, INK, 'bold', 'middle')
    c.text(600, 540, 'about 80 percent', 20, MUTED, 'normal', 'middle')
    c.box(820, 160, 320, 420, OKSUB, OK); c.text(980, 210, 'Close', 30, OK, 'bold', 'middle')
    c.text(980, 280, '1  Summary\n2  Call to action\n3  Final line', 24, INK, 'normal', 'middle')
    c.text(980, 450, 'about 10 percent\nof the time', 20, MUTED, 'normal', 'middle')
    c.arrow(384, 370, 436, 370); c.arrow(764, 370, 816, 370)
    c.badge(1, 90, 182, 'Opening', 'Open with a hook, say what the talk is about, and give a one-sentence preview of your points.')
    c.badge(2, 470, 182, 'Body', 'Three points is a good limit for a short talk. Give each point one example or one piece of proof.')
    c.badge(3, 850, 182, 'Close', 'Repeat the main idea, say what you want the audience to do, and finish on a short, clear line. Do not end with "that is all".')
    return c

def sp_audience():
    c = Canvas('Know your audience first', 'Three questions shape everything you say.')
    c.add(f'<polygon points="600,150 1000,540 200,540" fill="{ACCSUB}" stroke="{ACC}" stroke-width="3"/>')
    c.text(600, 330, 'Your talk', 32, ACC, 'bold', 'middle')
    c.box(60, 150, 330, 120, CARD); c.text(225, 195, 'Who are they?', 26, ACC, 'bold', 'middle'); c.text(225, 235, 'age, role, mood', 20, MUTED, 'normal', 'middle')
    c.box(810, 150, 330, 120, CARD); c.text(975, 195, 'What do they know?', 26, ACC, 'bold', 'middle'); c.text(975, 235, 'skip what they know', 20, MUTED, 'normal', 'middle')
    c.box(435, 570, 330, 90, CARD); c.text(600, 610, 'What do they need?', 26, ACC, 'bold', 'middle'); c.text(600, 642, 'start from their need', 20, MUTED, 'normal', 'middle')
    c.badge(1, 80, 170, 'Who', 'The same message sounds different to pupils, parents and a head teacher. Choose words and examples they use.')
    c.badge(2, 830, 170, 'What they know', 'If they know the basics, spend your time on what is new. If they do not, define terms in plain words.')
    c.badge(3, 455, 590, 'What they need', 'People listen when a talk answers a question they already have. Start from their need, not from your topic.')
    return c

def sp_voice():
    c = Canvas('Four dials of your voice', 'You control each one. Set them for the message.')
    dials = [('Pace', 'slow  ...  fast', 0.45, 'Aim for a pace people can follow. Slow down for numbers and key ideas.'), ('Volume', 'quiet  ...  loud', 0.65, 'Speak to the person at the back of the room. Loud enough to be heard, not to shout.'), ('Pitch', 'low  ...  high', 0.5, 'A varied pitch keeps people listening. A flat pitch sounds bored, even when you are not.'), ('Pause', 'short  ...  long', 0.7, 'A pause lets an idea land. Pause after a key point and before a new one.')]
    for i, (h, ends, pos, t) in enumerate(dials):
        y = 170 + i * 115
        c.text(70, y + 40, h, 30, ACC, 'bold'); c.box(260, y + 20, 760, 14, LINE, LINE, r=7, sw=0)
        c.box(260, y + 20, int(760 * pos), 14, ACC2, ACC2, r=7, sw=0); c.circle(int(260 + 760 * pos), y + 27, 22, ACC, CARD, 4)
        c.text(260, y + 72, ends.split('  ...  ')[0], 18, MUTED); c.text(1020, y + 72, ends.split('  ...  ')[1], 18, MUTED, 'normal', 'end')
        c.badge(i + 1, 1100, y + 27, h, t)
    return c

def sp_body():
    c = Canvas('Stand so your message is clear', 'Simple habits. No acting.')
    c.circle(420, 230, 55, CARD, INK, 4)
    c.line(420, 285, 420, 480, INK, 6); c.line(420, 330, 330, 410, INK, 6); c.line(420, 330, 510, 410, INK, 6)
    c.line(420, 480, 370, 600, INK, 6); c.line(420, 480, 470, 600, INK, 6)
    c.box(330, 600, 80, 16, ACCSUB, ACC, r=6); c.box(450, 600, 80, 16, ACCSUB, ACC, r=6)
    c.text(660, 200, 'Eyes', 28, ACC, 'bold'); c.text(660, 236, 'Look at one person for one\nthought, then move on.', 20, INK)
    c.text(660, 330, 'Shoulders and chest', 28, ACC, 'bold'); c.text(660, 366, 'Relaxed and open. Breathe low.', 20, INK)
    c.text(660, 440, 'Hands', 28, ACC, 'bold'); c.text(660, 476, 'Rest at waist height. Use them\nto show size, number or order.', 20, INK)
    c.text(660, 560, 'Feet', 28, ACC, 'bold'); c.text(660, 596, 'Shoulder width apart, weight even.', 20, INK)
    c.badge(1, 480, 205, 'Eyes', 'Eye contact tells people you are speaking to them. Hold it for a whole thought, not a flicker.')
    c.badge(2, 480, 300, 'Shoulders', 'Dropped, relaxed shoulders let you breathe deeper and sound steadier.')
    c.badge(3, 340, 430, 'Hands', 'Let your hands rest between gestures. Gestures should match what you say.')
    c.badge(4, 520, 600, 'Feet', 'A steady stance stops swaying and pacing. Move on purpose, such as when you start a new point.')
    return c

def sp_pause():
    c = Canvas('Pauses give ideas room', 'Silence is part of the sound.')
    import math
    pts = []
    for x in range(60, 1141, 6):
        env = 0
        if 60 <= x < 330: env = 1
        elif 400 <= x < 640: env = 1.3
        elif 760 <= x < 1141: env = 0.9
        a = env * (18 + 40 * abs(math.sin(x / 9.0)) * abs(math.sin(x / 41.0)))
        pts.append((x, 380 - a, 380 + a))
    for x, y1, y2 in pts: c.line(x, y1, x, y2, ACC2 if y1 < 380 else LINE, 3)
    c.box(330, 250, 70, 260, ACCSUB, ACCSUB, r=10, sw=0); c.box(640, 250, 120, 260, ACCSUB, ACCSUB, r=10, sw=0)
    c.text(365, 540, 'short\npause', 20, ACC, 'bold', 'middle'); c.text(700, 540, 'long pause\nafter the key idea', 20, ACC, 'bold', 'middle')
    c.text(190, 190, '"We lost 40 hours."', 24, INK, 'bold', 'middle'); c.text(520, 190, '"Every single year."', 24, INK, 'bold', 'middle'); c.text(950, 190, '"Here is how we fix it."', 24, INK, 'bold', 'middle')
    c.badge(1, 365, 270, 'Short pause', 'A short pause, about a second, replaces "um" and lets you think of the next phrase.')
    c.badge(2, 700, 270, 'Long pause', 'Pause for two or three seconds after your most important sentence. It feels long to you and natural to the audience.')
    return c

def sp_breath():
    c = Canvas('A calm breathing pattern', 'Use it before you speak. Nobody can see you do it.')
    parts = [('In', '4 counts', 'through the nose, low into the belly', 4, ACCSUB, ACC), ('Hold', '2 counts', 'gently, without strain', 2, CARD, MUTED), ('Out', '6 counts', 'slowly through the mouth', 6, OKSUB, OK)]
    x = 130
    for h, n, d, k, fill, col in parts:
        w = 70 * k + 30
        c.box(x, 230, w, 150, fill, col, r=16); c.text(x + w / 2, 290, h, 34, col, 'bold', 'middle'); c.text(x + w / 2, 335, n, 24, INK, 'bold', 'middle')
        c.text(x + w / 2, 430, d, 17, MUTED, 'normal', 'middle')
        for i in range(k): c.circle(x + 45 + i * 70, 365, 7, col, col, 0)
        x += w + 14
    c.text(600, 560, 'Repeat three times. Longer out-breaths help the body slow down.', 26, MUTED, 'normal', 'middle')
    c.badge(1, 150, 232, 'In', 'Breathe in low, into the belly, rather than lifting the shoulders.')
    c.badge(2, 505, 232, 'Hold', 'Hold without strain. If it is uncomfortable, shorten the count.')
    c.badge(3, 690, 232, 'Out', 'Breathe out slower than you breathed in. Stop if you feel dizzy and breathe normally.')
    return c

def sp_slides():
    c = Canvas('Slides support you. They do not replace you.', 'One idea per slide.')
    c.box(60, 160, 520, 340, CARD, '#b3423a', sw=3)
    c.text(90, 200, 'Quarterly results overview', 22, INK, 'bold')
    for i in range(7): c.text(90, 235 + i * 34, '- Revenue grew by 14.2% in Q3, driven by a mix of..', 15, MUTED)
    c.pill(60, 520, 520, 50, 'Too much text: they read, they do not listen', '#f7ece9', '#b3423a', 20)
    c.box(620, 160, 520, 340, CARD, OK, sw=3)
    c.text(880, 300, '14%', 110, ACC, 'bold', 'middle'); c.text(880, 380, 'sales growth in Q3', 30, INK, 'normal', 'middle')
    c.pill(620, 520, 520, 50, 'One idea, big and clear', OKSUB, OK, 20)
    c.badge(1, 70, 160, 'Crowded slide', 'People cannot read and listen at once. A wall of text makes them stop listening to you.')
    c.badge(2, 640, 160, 'Clear slide', 'One number or one image, with a few words. You supply the explanation by speaking.')
    return c

def sp_story():
    c = Canvas('A story in five beats', 'Short stories make points memorable.')
    beats = [('Situation', 'Who and where'), ('Problem', 'What went wrong'), ('Turning point', 'What changed'), ('Result', 'What happened'), ('Lesson', 'What it means for them')]
    for i, (h, s) in enumerate(beats):
        x = 50 + i * 226; y = 330 - [0, 70, 150, 90, 20][i]
        c.box(x, y, 200, 130, ACCSUB if i == 2 else CARD, ACC if i == 2 else LINE); c.text(x + 100, y + 50, h, 24, ACC, 'bold', 'middle'); c.text(x + 100, y + 90, s, 19, INK, 'normal', 'middle')
        if i < 4: c.arrow(x + 202, y + 65, x + 224, [330 - 70 + 65, 330 - 150 + 65, 330 - 90 + 65, 330 - 20 + 65][i])
        c.badge(i + 1, x + 100, y, h, ['Set the scene in one sentence: who, where and when.', 'Name the problem clearly. Without a problem there is no story.', 'Say the moment things changed. This is the heart of the story.', 'Show what happened afterwards, with a real detail if you can.', 'Tie the story back to your point and to what the audience should do.'][i])
    c.text(600, 600, 'In a 3-minute talk, a story should take about 30 seconds.', 24, MUTED, 'normal', 'middle')
    return c

def sp_qa():
    c = Canvas('Handling questions', 'A steady routine keeps you calm.')
    steps = [('1  Listen', 'Let them finish.\nDo not plan your\nanswer yet.'), ('2  Pause', 'Take a breath.\nOne second is\nenough.'), ('3  Repeat', 'Say the question\nback in short form\nfor the room.'), ('4  Answer', 'Give the answer\nfirst, then the\nreason.'), ('5  Check', 'Ask: "Does that\nanswer it?"')]
    for i, (h, b) in enumerate(steps):
        x = 40 + i * 228
        c.box(x, 220, 206, 280, ACCSUB if i == 3 else CARD, ACC if i == 3 else LINE); c.text(x + 103, 270, h, 26, ACC, 'bold', 'middle'); c.text(x + 103, 330, b, 21, INK, 'normal', 'middle')
        if i < 4: c.arrow(x + 208, 360, x + 226, 360)
        c.badge(i + 1, x + 22, 242, h.split('  ')[1], ['Many weak answers come from answering the question you expected, not the one asked.', 'A pause shows you are thinking. It is a strength, not a weakness.', 'Repeating helps people who did not hear it, and gives you time.', 'Lead with the answer. Then give one reason or example. Stop.', 'A quick check stops a long answer that misses the point.'][i])
    c.pill(60, 560, 1080, 56, 'If you do not know: say so, and say how you will find out.', OKSUB, OK, 24)
    return c

def sp_persuade():
    c = Canvas('Three ways to persuade', 'Strong talks use all three.')
    c.add(f'<polygon points="600,200 1000,520 200,520" fill="{CARD}" stroke="{ACC}" stroke-width="3"/>')
    c.text(600, 160, 'Credibility', 30, ACC, 'bold', 'middle'); c.text(600, 188, 'Why listen to you?', 20, MUTED, 'normal', 'middle')
    c.text(250, 570, 'Emotion', 30, ACC, 'bold', 'middle'); c.text(250, 605, 'Why should they care?', 20, MUTED, 'normal', 'middle')
    c.text(950, 570, 'Logic', 30, ACC, 'bold', 'middle'); c.text(950, 605, 'Why is it true?', 20, MUTED, 'normal', 'middle')
    c.text(600, 400, 'Your message', 34, INK, 'bold', 'middle')
    c.badge(1, 600, 290, 'Credibility', 'Show your experience or sources briefly. Be honest about what you do not know.')
    c.badge(2, 320, 480, 'Emotion', 'A real example or story helps people feel why the issue matters. Use it with care and do not exaggerate.')
    c.badge(3, 880, 480, 'Logic', 'Use clear reasons, numbers and examples that the audience can check.')
    return c

def sp_feedback():
    c = Canvas('Practise with a feedback loop', 'Small, repeated improvements beat one long rehearsal.')
    nodes = [('Record yourself', 600, 180), ('Listen back', 900, 330), ('Pick ONE fix', 600, 480), ('Speak it again', 300, 330)]
    for h, x, y in nodes:
        c.box(x - 130, y - 50, 260, 100, ACCSUB if h.startswith('Pick') else CARD, ACC if h.startswith('Pick') else LINE); c.text(x, y + 10, h, 26, ACC, 'bold', 'middle')
    c.arrow(730, 215, 800, 285); c.arrow(840, 380, 730, 445); c.arrow(470, 445, 360, 380); c.arrow(360, 285, 470, 215)
    c.text(600, 340, 'Repeat\nthree times', 26, MUTED, 'bold', 'middle')
    c.badge(1, 500, 150, 'Record', 'Use your phone. Speak for one minute, as if the audience were in front of you.')
    c.badge(2, 800, 300, 'Listen back', 'Listen once for content, and once for delivery: pace, fillers and pauses.')
    c.badge(3, 500, 450, 'One fix', 'Choose one thing, for example fewer filler words. Fixing five things at once fixes none.')
    return c

def sp_cover():
    c = Canvas('Public Speaking Essentials', 'Open strongly. Structure clearly. Speak with confidence.')
    c.box(120, 190, 460, 330, CARD); c.text(350, 250, 'Opening', 28, ACC, 'bold', 'middle')
    for i in range(3): c.box(160, 285 + i * 62, 380, 48, ACCSUB, ACC2, r=10)
    c.box(660, 190, 420, 330, OKSUB, OK); c.text(870, 250, 'Say it aloud', 28, OK, 'bold', 'middle'); c.circle(870, 380, 60, CARD, OK, 5); c.box(852, 340, 36, 60, OK, OK, r=18); c.line(870, 420, 870, 440, OK, 5)
    c.pill(120, 560, 540, 56, 'Record yourself and get feedback', ACCSUB, ACC, 24)
    return c

ALL = [
 ('sp-cover', 'speaking/cover', 'Public Speaking Essentials course cover with a talk outline and a microphone', 'Public Speaking Essentials', sp_cover),
 ('sp-openings', 'speaking/openings', 'Three cards showing a surprising fact, a short question and a one-line story as ways to open a talk', 'Three openings that work.', sp_openings),
 ('sp-structure', 'speaking/structure', 'A talk in three parts: opening with hook, topic and preview; body with three points; close with summary and call to action', 'Opening, body and close.', sp_structure),
 ('sp-audience', 'speaking/audience', 'A triangle with the three audience questions: who they are, what they know, what they need', 'Start from the audience.', sp_audience),
 ('sp-voice', 'speaking/voice', 'Four sliders for pace, volume, pitch and pause', 'Four dials of the voice.', sp_voice),
 ('sp-body', 'speaking/body', 'A stick figure with labels for eyes, shoulders, hands and feet', 'Posture and gesture basics.', sp_body),
 ('sp-pause', 'speaking/pause', 'A sound wave with a short pause and a long pause marked', 'Pauses give ideas room.', sp_pause),
 ('sp-breath', 'speaking/breath', 'A breathing pattern: in for 4, hold for 2, out for 6', 'A calm breathing pattern.', sp_breath),
 ('sp-slides', 'speaking/slides', 'A crowded slide marked as poor next to a single big number slide marked as good', 'One idea per slide.', sp_slides),
 ('sp-story', 'speaking/story', 'A five-beat story arc: situation, problem, turning point, result, lesson', 'A story in five beats.', sp_story),
 ('sp-qa', 'speaking/qa', 'Five steps for handling questions: listen, pause, repeat, answer, check', 'A routine for questions.', sp_qa),
 ('sp-persuade', 'speaking/persuade', 'A triangle with credibility, emotion and logic around the message', 'Three ways to persuade.', sp_persuade),
 ('sp-feedback', 'speaking/feedback', 'A loop: record yourself, listen back, pick one fix, speak it again', 'The practice loop.', sp_feedback),
]
