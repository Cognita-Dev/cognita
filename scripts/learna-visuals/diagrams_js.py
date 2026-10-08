from lib import *

def js_run_code():
    c = Canvas('How JavaScript code runs', 'You write instructions. The engine follows them in order.')
    xs = [60, 440, 820]
    heads = ['1  You write code', '2  The engine reads it', '3  You see the result']
    c.card(xs[0], 190, 320, 300, heads[0], '', CARD)
    c.box(xs[0] + 24, 270, 272, 190, '#1f1f1f', '#1f1f1f', r=12)
    c.text(xs[0] + 40, 312, 'const a = 4;', 22, '#f5e6da', mono=True)
    c.text(xs[0] + 40, 350, 'const b = 3;', 22, '#f5e6da', mono=True)
    c.text(xs[0] + 40, 388, 'console.log(a + b);', 22, '#f5e6da', mono=True)
    c.card(xs[1], 190, 320, 300, heads[1], '', ACCSUB)
    c.text(xs[1] + 160, 290, 'Starts at the top.\nReads one line,\ndoes it, then moves\nto the next line.', 24, INK, 'normal', 'middle')
    c.card(xs[2], 190, 320, 300, heads[2], '', CARD)
    c.box(xs[2] + 24, 270, 272, 190, '#1f1f1f', '#1f1f1f', r=12)
    c.text(xs[2] + 40, 312, '> 7', 30, '#a7d2c1', mono=True)
    c.text(xs[2] + 40, 370, 'Output appears in\nthe console.', 20, '#d9d6cf')
    c.arrow(384, 340, 436, 340); c.arrow(764, 340, 816, 340)
    c.badge(1, 356, 192, 'Your code', 'You type instructions in the editor. Each instruction is a statement, and most end with a semicolon.')
    c.badge(2, 736, 192, 'The engine', 'JavaScript runs from the top to the bottom. If line 2 needs a value from line 1, line 1 must come first.')
    c.badge(3, 1116, 192, 'The output', 'console.log shows a value so you can check it. A return value is different: it goes back to the code that called the function.')
    c.pill(60, 540, 1080, 60, 'Order matters: a line can only use values created above it.', ACCSUB, ACC, 24)
    return c

def js_variables():
    c = Canvas('Variables are labelled boxes', 'The label is the name. The box holds one value at a time.')
    c.card(80, 170, 460, 300, 'const price', '', CARD)
    c.box(200, 280, 220, 110, ACCSUB, ACC, r=14); c.text(310, 350, '1500', 44, ACC, 'bold', 'middle', mono=True)
    c.pill(150, 410, 320, 44, 'locked: cannot be reassigned', OKSUB, OK, 20)
    c.card(660, 170, 460, 300, 'let quantity', '', CARD)
    c.box(780, 280, 100, 110, ACCSUB, ACC, r=14); c.text(830, 350, '2', 44, ACC, 'bold', 'middle', mono=True)
    c.arrow(890, 335, 940, 335)
    c.box(950, 280, 100, 110, ACCSUB, ACC, r=14); c.text(1000, 350, '3', 44, ACC, 'bold', 'middle', mono=True)
    c.pill(740, 410, 320, 44, 'open: can be given a new value', ACCSUB, ACC, 20)
    c.text(310, 530, 'const total = price * quantity;', 26, INK, 'normal', 'middle', True)
    c.text(890, 530, 'quantity = quantity + 1;', 26, INK, 'normal', 'middle', True)
    c.text(600, 600, 'Use const by default. Use let only when the value must change.', 24, MUTED, 'normal', 'middle')
    c.badge(1, 110, 190, 'The name', 'The name comes after const or let. Choose a clear name: price is better than p.')
    c.badge(2, 310, 270, 'The value', 'A variable holds a value such as a number or text. The value sits inside the box.')
    c.badge(3, 122, 432, 'const', 'const means the name cannot be pointed at a new value. price = 2000 would cause an error.')
    c.badge(4, 890, 300, 'Reassigning', 'With let you can store a new value. Here quantity goes from 2 to 3.')
    return c

def js_types():
    c = Canvas('The basic kinds of value', 'typeof tells you which kind a value is.')
    data = [('number', '42\n3.14\n-7', 'for counting and maths'), ('string', '"Ada"\n\'Lagos\'', 'for text, in quotes'), ('boolean', 'true\nfalse', 'for yes or no'), ('undefined', 'let x;', 'nothing was given yet'), ('null', 'null', 'empty on purpose')]
    for i, (h, ex, note) in enumerate(data):
        x = 52 + i * 224
        c.box(x, 170, 204, 360)
        c.add(f'<rect x="{x}" y="170" width="204" height="70" rx="18" fill="{ACC}"/><rect x="{x}" y="215" width="204" height="25" fill="{ACC}"/>')
        c.text(x + 102, 216, h, 26, CARD, 'bold', 'middle')
        c.text(x + 102, 310, ex, 28, INK, 'normal', 'middle', True)
        c.text(x + 102, 480, note, 18, MUTED, 'normal', 'middle')
        c.badge(i + 1, x + 24, 258, h, ['Numbers can be whole or decimal. Use + - * / to calculate.', 'Strings are text. They need quotes. "5" is text, 5 is a number.', 'Booleans are only true or false. They are what conditions produce.', 'undefined is what you get from a variable that was never given a value.', 'null means you chose to leave it empty. It is different from undefined.'][i])
    c.text(600, 595, 'Arrays and objects hold many values. You meet them later in this course.', 24, MUTED, 'normal', 'middle')
    return c

def js_if_flow():
    c = Canvas('A decision: if and else', 'The condition is a question with a true or false answer.')
    c.box(470, 140, 260, 70, ACCSUB, ACC, r=35); c.text(600, 185, 'Start', 26, ACC, 'bold', 'middle')
    c.arrow(600, 210, 600, 250)
    c.add(f'<polygon points="600,250 780,330 600,410 420,330" fill="{CARD}" stroke="{ACC}" stroke-width="3"/>')
    c.text(600, 322, 'score >= 50 ?', 26, INK, 'bold', 'middle', True); c.text(600, 356, 'true or false', 20, MUTED, 'normal', 'middle')
    c.arrow(420, 330, 260, 330); c.text(340, 312, 'true', 22, OK, 'bold', 'middle')
    c.arrow(780, 330, 940, 330); c.text(860, 312, 'false', 22, ACC, 'bold', 'middle')
    c.box(80, 290, 180, 80, OKSUB, OK, r=14); c.text(170, 322, 'return', 22, OK, 'bold', 'middle', True); c.text(170, 352, '"pass"', 22, INK, 'normal', 'middle', True)
    c.box(940, 290, 180, 80, ACCSUB, ACC, r=14); c.text(1030, 322, 'return', 22, ACC, 'bold', 'middle', True); c.text(1030, 352, '"fail"', 22, INK, 'normal', 'middle', True)
    c.text(600, 500, 'if (score >= 50) {\n  return "pass";\n} else {\n  return "fail";\n}', 24, INK, 'normal', 'middle', True)
    c.badge(1, 450, 280, 'The condition', 'The condition goes in brackets after if. It must give true or false. Comparison operators such as >=, === and < produce booleans.')
    c.badge(2, 200, 290, 'The true branch', 'This block runs only when the condition is true.')
    c.badge(3, 1000, 290, 'The else branch', 'This block runs when the condition is false. Exactly one of the two branches runs.')
    return c

def js_function():
    c = Canvas('A function is a small machine', 'Inputs go in. One result comes out.')
    c.box(60, 230, 240, 200, CARD); c.text(180, 280, 'Inputs', 26, ACC, 'bold', 'middle'); c.text(180, 340, 'parameters\nprice, quantity', 22, INK, 'normal', 'middle', True)
    c.box(400, 190, 400, 280, ACCSUB, ACC, r=22); c.text(600, 240, 'function totalPrice', 24, ACC, 'bold', 'middle', True)
    c.text(600, 320, 'let subtotal =\n  price * quantity;', 24, INK, 'normal', 'middle', True)
    c.text(600, 420, 'return subtotal;', 24, ACC, 'bold', 'middle', True)
    c.box(900, 230, 240, 200, OKSUB, OK); c.text(1020, 280, 'Result', 26, OK, 'bold', 'middle'); c.text(1020, 340, 'the returned\nvalue: 3000', 22, INK, 'normal', 'middle', True)
    c.arrow(300, 330, 396, 330); c.arrow(804, 330, 896, 330)
    c.text(600, 530, 'totalPrice(1500, 2)  gives back  3000', 28, INK, 'bold', 'middle', True)
    c.text(600, 585, 'console.log shows a value on screen. return hands the value back to the caller.', 22, MUTED, 'normal', 'middle')
    c.badge(1, 90, 250, 'Parameters', 'Parameters are the names the function uses for its inputs. The caller supplies the real values, called arguments.')
    c.badge(2, 430, 212, 'The body', 'The body is the code between the curly brackets. It runs each time the function is called.')
    c.badge(3, 930, 250, 'The return value', 'return ends the function and sends a value back. A function with no return gives back undefined.')
    return c

def js_scope():
    c = Canvas('Scope: where a name can be seen', 'Inner boxes can see outward. Outer boxes cannot see inward.')
    c.box(60, 150, 1080, 470, '#fbfbfa', LINE, r=22); c.text(90, 190, 'Global scope', 24, MUTED, 'bold')
    c.text(90, 235, 'const school = "Fahmid";', 24, INK, 'normal', 'start', True)
    c.box(140, 270, 920, 320, ACCSUB, ACC, r=22); c.text(170, 310, 'Inside function greet()', 24, ACC, 'bold')
    c.text(170, 352, 'const name = "Ada";', 24, INK, 'normal', 'start', True)
    c.box(220, 390, 760, 170, CARD, ACC2, r=18); c.text(250, 430, 'Inside an if block { }', 24, ACC2, 'bold')
    c.text(250, 475, 'let note = school + name;', 24, INK, 'normal', 'start', True)
    c.text(250, 520, '// can see school, name and note', 20, OK, 'normal', 'start', True)
    c.badge(1, 1090, 190, 'Global', 'A name declared outside every function can be used anywhere. Too many globals make code hard to follow.')
    c.badge(2, 1010, 310, 'Function scope', 'A name declared inside a function exists only inside that function. Outside it, using the name causes a ReferenceError.')
    c.badge(3, 930, 430, 'Block scope', 'let and const stay inside the nearest curly brackets, such as an if block or a loop.')
    return c

def js_array():
    c = Canvas('An array is an ordered list', 'Each item sits in a numbered position. Counting starts at 0.')
    vals = ['"Ada"', '"Tobi"', '"Zainab"', '"Kemi"', '"Ife"']
    for i, v in enumerate(vals):
        x = 70 + i * 210
        c.box(x, 250, 190, 120, ACCSUB if i in (0, 4) else CARD, ACC if i in (0, 4) else LINE, r=14)
        c.text(x + 95, 322, v, 30, INK, 'bold', 'middle', True)
        c.text(x + 95, 410, f'[{i}]', 30, ACC, 'bold', 'middle', True)
    c.text(600, 170, 'const names = ["Ada", "Tobi", "Zainab", "Kemi", "Ife"];', 24, INK, 'bold', 'middle', True)
    c.text(600, 495, 'names[0] is "Ada"          names.length is 5', 24, INK, 'normal', 'middle', True)
    c.text(600, 535, 'the last item is names[names.length - 1]', 24, INK, 'normal', 'middle', True)
    c.text(600, 595, 'The last index is always length minus one.', 24, MUTED, 'normal', 'middle')
    c.badge(1, 100, 270, 'The first item', 'The first item is at index 0, not 1. This catches many beginners.')
    c.badge(2, 215, 400, 'Index', 'The index is the position number in square brackets. names[2] gives "Zainab".')
    c.badge(3, 940, 270, 'The last item', 'With 5 items the last index is 4. Use names[names.length - 1] to get the last item for any length.')
    return c

def js_loop():
    c = Canvas('A loop repeats steps', 'for (let i = 0; i < 3; i++) { ... }')
    c.box(50, 210, 230, 110, CARD); c.text(165, 252, '1  Start', 24, ACC, 'bold', 'middle'); c.text(165, 290, 'let i = 0', 24, INK, 'normal', 'middle', True)
    c.box(350, 210, 230, 110, CARD); c.text(465, 252, '2  Test', 24, ACC, 'bold', 'middle'); c.text(465, 290, 'i < 3 ?', 24, INK, 'normal', 'middle', True)
    c.box(650, 210, 270, 110, ACCSUB, ACC); c.text(785, 252, '3  Run the body', 24, ACC, 'bold', 'middle'); c.text(785, 290, 'console.log(i)', 24, INK, 'normal', 'middle', True)
    c.box(990, 210, 170, 110, CARD); c.text(1075, 252, '4  Update', 24, ACC, 'bold', 'middle'); c.text(1075, 290, 'i++', 24, INK, 'normal', 'middle', True)
    c.box(350, 420, 230, 110, OKSUB, OK); c.text(465, 462, 'Stop', 24, OK, 'bold', 'middle'); c.text(465, 500, 'the loop ends', 20, INK, 'normal', 'middle')
    c.arrow(280, 265, 346, 265); c.arrow(580, 265, 646, 265); c.text(613, 248, 'true', 20, OK, 'bold', 'middle')
    c.arrow(920, 265, 986, 265)
    c.arrow(465, 320, 465, 416); c.text(445, 375, 'false', 20, ACC, 'bold', 'end')
    c.line(1075, 210, 1075, 165, ACC, 4); c.line(1075, 165, 465, 165, ACC, 4); c.arrow(465, 165, 465, 206, ACC)
    c.text(770, 150, 'then test again', 20, ACC, 'bold', 'middle')
    c.text(600, 600, 'The output is 0, 1, 2. At i = 3 the test is false, so the loop stops.', 24, INK, 'normal', 'middle')
    c.badge(1, 70, 210, 'Start', 'The start runs once, before the first test. It usually creates the counter.')
    c.badge(2, 370, 210, 'Test', 'Before every round the loop asks the test. If it is true the body runs. If false the loop ends.')
    c.badge(3, 670, 210, 'Body', 'The body is the work done on each round. Be careful: a body that never changes the counter makes an endless loop.')
    c.badge(4, 1010, 210, 'Update', 'The update changes the counter so the loop moves toward finishing.')
    return c

def js_pipeline():
    c = Canvas('map, filter and reduce', 'Three tools for working with lists, one idea each.')
    rows = [('map', 'change every item', [2, 4, 6], '.map(n => n * 10)', [20, 40, 60], 170), ('filter', 'keep some items', [2, 4, 6], '.filter(n => n > 3)', [4, 6], 330), ('reduce', 'combine into one value', [2, 4, 6], '.reduce((s, n) => s + n, 0)', [12], 490)]
    for name, note, a, call, out, y in rows:
        c.box(50, y, 1100, 130, CARD)
        c.text(95, y + 66, name, 34, ACC, 'bold', mono=True); c.text(95, y + 102, note, 18, MUTED)
        for i, v in enumerate(a):
            c.box(300 + i * 70, y + 35, 58, 58, ACCSUB, ACC, r=10); c.text(329 + i * 70, y + 74, str(v), 26, INK, 'bold', 'middle', True)
        c.arrow(510, y + 64, 545, y + 64)
        c.text(555, y + 72, call, 20, INK, 'normal', 'start', True)
        c.arrow(885, y + 64, 925, y + 64)
        for i, v in enumerate(out):
            c.box(935 + i * 70, y + 35, 58, 58, OKSUB, OK, r=10); c.text(964 + i * 70, y + 74, str(v), 26, INK, 'bold', 'middle', True)
    c.badge(1, 70, 190, 'map', 'map returns a new array the same length. Every item is passed through your function.')
    c.badge(2, 70, 350, 'filter', 'filter returns a new array with only the items for which your function returned true.')
    c.badge(3, 70, 510, 'reduce', 'reduce walks through the list keeping a running total (the accumulator) and returns one value.')
    return c

def js_object():
    c = Canvas('An object groups related facts', 'Each fact has a name (the key) and a value.')
    c.box(60, 150, 520, 440, CARD); c.add(f'<rect x="60" y="150" width="520" height="70" rx="18" fill="{ACC}"/><rect x="60" y="195" width="520" height="25" fill="{ACC}"/>')
    c.text(320, 196, 'pupil', 30, CARD, 'bold', 'middle', True)
    rows = [('name', '"Ada"'), ('age', '12'), ('class', '"JSS 1"'), ('scores', '[70, 82, 91]')]
    for i, (k, v) in enumerate(rows):
        y = 260 + i * 80
        c.text(135, y + 36, k + ':', 28, ACC, 'bold', mono=True); c.text(320, y + 36, v, 28, INK, 'normal', mono=True)
        c.line(90, y + 56, 550, y + 56, LINE, 2)
    c.text(660, 215, 'const pupil = {', 24, INK, 'normal', 'start', True)
    c.text(690, 255, 'name: "Ada",\nage: 12,\nclass: "JSS 1",\nscores: [70, 82, 91],', 24, INK, 'normal', 'start', True)
    c.text(660, 400, '};', 24, INK, 'normal', 'start', True)
    c.box(640, 440, 500, 150, ACCSUB, ACC, r=16)
    c.text(665, 485, 'pupil.name        ->  "Ada"', 22, INK, 'normal', 'start', True)
    c.text(665, 525, 'pupil["age"]      ->  12', 22, INK, 'normal', 'start', True)
    c.text(665, 565, 'pupil.scores[1]  ->  82', 22, INK, 'normal', 'start', True)
    c.badge(1, 96, 296, 'Key', 'The key is the name of the fact. Keys are usually written without quotes.')
    c.badge(2, 530, 296, 'Value', 'A value can be any kind: number, string, boolean, array or even another object.')
    c.badge(3, 1118, 442, 'Dot access', 'Use a dot to read a property: pupil.name. Use square brackets when the key is stored in a variable: pupil[key].')
    return c

def js_debug():
    c = Canvas('Debugging is a loop, not a guess', 'Change one thing at a time, then test again.')
    steps = [('1  Reproduce', 'Make the problem\nhappen every time.', 100, 190), ('2  Read', 'Read the error message.\nNote the line number.', 450, 190), ('3  Narrow down', 'Print values with\nconsole.log to find\nwhere it goes wrong.', 800, 190), ('4  Fix one thing', 'Change one line.\nNot five.', 800, 410), ('5  Test again', 'Run the same case.\nThen try a new one.', 450, 410)]
    for h, b, x, y in steps:
        c.box(x, y, 300, 170, ACCSUB if h.startswith('3') else CARD, ACC if h.startswith('3') else LINE)
        c.text(x + 150, y + 46, h, 26, ACC, 'bold', 'middle'); c.text(x + 150, y + 90, b, 21, INK, 'normal', 'middle')
    c.arrow(400, 275, 446, 275); c.arrow(750, 275, 796, 275); c.arrow(950, 360, 950, 406); c.arrow(796, 495, 754, 495)
    c.line(450, 495, 250, 495, ACC, 4); c.arrow(250, 495, 250, 364)
    c.text(600, 640, 'If it still fails, go back to step 2 with fresh eyes.', 24, MUTED, 'normal', 'middle')
    c.badge(1, 120, 210, 'Reproduce', 'You cannot fix what you cannot repeat. Write down the exact input that fails.')
    c.badge(2, 470, 210, 'Read the error', 'Error messages name the problem and the line. TypeError and ReferenceError point to different causes.')
    c.badge(3, 820, 210, 'Narrow down', 'console.log a value before and after the suspect line. The first place it looks wrong is where to look.')
    return c

def js_capstone():
    c = Canvas('Capstone: a pupil results report', 'One small program built from the parts you have learned.')
    c.box(60, 200, 260, 260, CARD); c.text(190, 250, 'Data', 28, ACC, 'bold', 'middle'); c.text(190, 310, 'an array of\npupil objects\nwith scores', 22, INK, 'normal', 'middle')
    c.box(400, 150, 400, 360, ACCSUB, ACC, r=22); c.text(600, 200, 'Functions', 28, ACC, 'bold', 'middle')
    for i, f in enumerate(['average(scores)', 'grade(average)', 'topPupil(pupils)', 'report(pupils)']):
        c.box(440, 230 + i * 62, 320, 50, CARD, ACC2, r=10); c.text(600, 263 + i * 62, f, 22, INK, 'normal', 'middle', True)
    c.box(880, 200, 260, 260, OKSUB, OK); c.text(1010, 250, 'Report', 28, OK, 'bold', 'middle'); c.text(1010, 310, 'a clear text\nsummary with\ngrades', 22, INK, 'normal', 'middle')
    c.arrow(320, 330, 396, 330); c.arrow(804, 330, 876, 330)
    c.text(600, 580, 'Plan on paper first. Build one function at a time. Test each before the next.', 24, MUTED, 'normal', 'middle')
    c.badge(1, 90, 220, 'Data', 'Start with data that looks like a real class list. Arrays hold the pupils, objects hold each pupil.')
    c.badge(2, 430, 172, 'Functions', 'Each function does one job. Small functions are easy to test and to reuse.')
    c.badge(3, 910, 220, 'Report', 'The final function joins the smaller ones and returns the text of the report.')
    return c

def js_cover():
    c = Canvas('JavaScript Foundations', 'Write real code. Run real tests. Build a real program.')
    snippets = ['const total = price * qty;', 'if (score >= 50) { ... }', 'function greet(name) { ... }', 'names.map(n => n.length)', 'pupil.scores[1]']
    for i, s in enumerate(snippets):
        c.box(120 + (i % 2) * 520, 190 + i * 74, 460, 58, CARD, LINE, r=12); c.text(150 + (i % 2) * 520, 228 + i * 74, s, 22, INK, 'normal', 'start', True)
    c.pill(60, 580, 540, 56, 'Practise in the Cognita sandbox', ACCSUB, ACC, 24)
    return c

ALL = [
 ('js-cover', 'js/cover', 'JavaScript Foundations course cover with small code snippets', 'JavaScript Foundations', js_cover),
 ('js-run-code', 'js/run-code', 'Three boxes showing code being written, read by the JavaScript engine line by line, and producing output', 'Code runs from the top to the bottom, one line at a time.', js_run_code),
 ('js-variables', 'js/variables', 'Two labelled boxes: a const price locked at 1500 and a let quantity that changes from 2 to 3', 'const holds a value that stays. let holds a value you may change.', js_variables),
 ('js-types', 'js/types', 'Five cards showing number, string, boolean, undefined and null with examples', 'The basic kinds of value in JavaScript.', js_types),
 ('js-if-flow', 'js/if-flow', 'Flowchart: a score is tested, then the program returns pass when true and fail when false', 'Exactly one branch of an if/else runs.', js_if_flow),
 ('js-function', 'js/function', 'A machine: parameters go in, the function body runs, and a returned value comes out', 'Parameters in, return value out.', js_function),
 ('js-scope', 'js/scope', 'Three nested boxes for global, function and block scope', 'Inner scopes see outward. Outer scopes cannot see inward.', js_scope),
 ('js-array', 'js/array', 'An array of five names with index numbers 0 to 4 under the cells', 'Arrays count from 0. The last index is length minus one.', js_array),
 ('js-loop', 'js/loop', 'Loop cycle: start, test, run the body, update, then test again until the test is false', 'A for loop: start, test, body, update.', js_loop),
 ('js-pipeline', 'js/pipeline', 'Three rows showing map, filter and reduce turning the list 2, 4, 6 into new results', 'map changes, filter keeps, reduce combines.', js_pipeline),
 ('js-object', 'js/object', 'A pupil object drawn as a card of keys and values, with examples of dot access', 'An object stores named facts together.', js_object),
 ('js-debug', 'js/debug', 'A loop of five debugging steps: reproduce, read the error, narrow down, fix one thing, test again', 'Debug with a method, one change at a time.', js_debug),
 ('js-capstone', 'js/capstone', 'Plan for the capstone: pupil data flows through four functions into a results report', 'The capstone project, planned as data, functions and a report.', js_capstone),
]
