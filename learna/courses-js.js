// learna/courses-js.js
// JavaScript Foundations: 6 sections, 20 lessons, a final assessment and a capstone project.
// Code tasks run in the Cognita sandbox. tests are shown to the learner (expression only); hidden is a pool of extra
// cases, two of which are added to every run. Every solution here is checked against its own tests by tests/learna.test.mjs.
import { teach, lesson, section, choice, fill, codeTask, assignment, activity, T, H } from './courses-core.js';
import { VIS } from './visuals.js';

const say = (id, title, prompt, hints, rubric, exemplar, explain, minWords = 12) => activity(id, 'reflection', title, {
  type: 'open', mode: 'writing', voice: true, prompt, minWords, minCriteria: Math.max(1, rubric.length - 1), rubric, hints, exemplar, explain,
});

export const javascript = {
  id: 'javascript-foundations',
  title: 'JavaScript Foundations',
  shortDescription: 'Go from zero to a working program: values, decisions, functions, lists, objects and a real project.',
  fullDescription: 'A complete first course in JavaScript. You learn by writing code, running it in the Cognita sandbox in your browser, and checking it against tests. Each section builds on the one before: values and variables, decisions, functions, lists and loops, objects and text, then debugging and a capstone project that builds a pupil results report. Pictures and short diagrams explain each big idea, and your tutor knows exactly which lesson and step you are on.',
  category: 'coding', level: 'Beginner', estimatedDuration: '8 hours', estimatedMinutes: 480,
  whoFor: 'People who have never programmed, and people who tried before and want solid foundations. No maths beyond school arithmetic is needed.',
  prerequisites: ['A computer, tablet or phone with a modern browser', 'Comfort with typing and with basic arithmetic', 'No programming experience needed'],
  learningOutcomes: [
    'Explain how JavaScript reads and runs code', 'Store and change values with const and let', 'Make decisions with comparisons, if/else and logical operators',
    'Write functions with parameters and return values', 'Process lists with arrays, loops, map, filter and reduce', 'Model real things with objects and arrays of objects',
    'Find and fix bugs with a method', 'Build a small results-report program from scratch',
  ],
  skills: ['Variables', 'Types', 'Conditions', 'Functions', 'Scope', 'Arrays', 'Loops', 'Objects', 'Strings', 'Debugging'],
  practical: '39 coding tasks and 88 activities in all, each code task with tests. A final assessment, then a capstone project: a pupil results report that you submit for review.',
  assessment: 'Questions are checked exactly. Code tasks run in your browser sandbox and are re-checked by Cognita with extra hidden cases. Each lesson needs 70% of its activities passed without seeing the answer. The final assessment needs 75%. The capstone is reviewed by a person before a certificate is issued.',
  modes: ['coding', 'reading', 'testing', 'projects'],
  cover: VIS.jsCover.src,
  access: 'plus', status: 'available', featured: true, version: '2.0.0', masteryThreshold: 0.7,
  certificate: { enabled: true, title: 'Certificate in JavaScript Foundations' },
  references: [{ label: 'MDN Web Docs: JavaScript', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript' }],
  sections: [
    // ───────────────────────────── 1 ─────────────────────────────
    section('s1', 'Getting started', 'How code runs, and how to hold information in variables.', [
      lesson('l1', 'How code runs', 'By the end of this lesson, you can say in what order JavaScript runs lines and use console.log to see a value.', 20, [
        teach('t1', 'introduction', 'Instructions, in order', [
          'A program is a list of instructions. JavaScript follows them from the top to the bottom, one line at a time. A line can only use things that were created above it.',
          'Use console.log(value) to show a value. It does not change the value. It is a way to look at what your program is doing, and you will use it all the time.',
        ], { label: 'Example', text: 'const a = 4;\nconst b = 3;\nconsole.log(a + b); // shows 7' }, { visual: VIS.jsRunCode }),
        choice('a1', 'guided', 'Which line runs first?', 'In this code, which line runs first?\n\n1: console.log(total);\n2: const total = 5 + 5;\n3: console.log("done");', ['Line 1', 'Line 2', 'Line 3'], 0, 'JavaScript always starts at the top. Line 1 runs first, but total does not exist yet, so it causes an error.', { why: { 1: 'Line 2 comes after line 1, so it cannot run first.', 2: 'Line 3 is last.' }, hints: ['Start at the top and read down.'] }),
        choice('a2', 'guided', 'What is shown?', 'What does this show?\n\nconst x = 2;\nconst y = 5;\nconsole.log(x * y);', ['7', '10', '25'], 1, 'The * operator multiplies. 2 * 5 is 10.', { why: { 0: 'That is x + y. The operator is *.', 2: 'That is y * y.' } }),
        codeTask('a3', 'attempt', 'Return a value', {
          prompt: 'Write a function double(n) that returns n multiplied by 2.', starter: 'function double(n) {\n  // your code here\n}\n',
          tests: [T('double(4)', 8), T('double(0)', 0), T('double(-3)', -6)], hidden: [H('double(21)', 42), H('double(0.5)', 1), H('double(1000)', 2000)], mustDefine: ['double'],
          solution: 'function double(n) {\n  return n * 2;\n}', hints: ['A function sends a value back with return.', 'return n * 2;'], explain: 'return sends the result back to the code that called the function.',
        }),
        choice('a4', 'checkpoint', 'Spot the order problem', 'Which version works?', ['console.log(price);\nconst price = 100;', 'const price = 100;\nconsole.log(price);'], 1, 'The value must exist before it is used. Put the declaration first.', { why: { 0: 'price is used before it is created.' } }),
      ], 2),
      lesson('l2', 'Variables', 'By the end of this lesson, you can declare variables with const and let and use them in a calculation.', 25, [
        teach('t1', 'explanation', 'A variable is a named box', [
          'A variable stores a value so you can use it later. Use const for a value that will not be reassigned, and let for a value that will change.',
          'Choose names that say what the value means: totalPrice is better than t. Names are case sensitive: Price and price are different.',
        ], { label: 'Example', text: 'const price = 1500;\nlet quantity = 2;\nquantity = quantity + 1;\nconst total = price * quantity; // 4500' }, { visual: VIS.jsVariables }),
        choice('a1', 'guided', 'Predict the value', 'What is the value of total?\n\nconst a = 4;\nlet b = 3;\nb = b + 2;\nconst total = a * b;', ['12', '20', '14'], 1, 'b becomes 5, so total is 4 * 5 = 20.', { why: { 0: 'b changed to 5 before the multiplication.', 2: 'The operator is *, not +.' }, hints: ['Work out b first. It changes on line 3.'] }),
        choice('a2', 'guided', 'Const or let?', 'You are counting clicks. The number goes up each time. Which keyword should declare it?', ['const', 'let'], 1, 'Use let when the value is reassigned.', { why: { 0: 'A const variable cannot be reassigned, so count = count + 1 would fail.' }, hints: ['Does the value change?'] }),
        choice('a3', 'guided', 'Which line fails?', 'Which code causes an error?', ['let n = 1; n = 2;', 'const n = 1; n = 2;', 'const n = 1; const m = n + 1;'], 1, 'A const cannot be reassigned.', { why: { 0: 'let allows reassignment.', 2: 'This only reads n.' }, hints: ['One line assigns to a const.'] }),
        codeTask('a4', 'attempt', 'Use variables in a function', {
          prompt: 'Write a function totalPrice(price, quantity) that returns price multiplied by quantity. Use a const inside the function for the result.',
          starter: 'function totalPrice(price, quantity) {\n  // your code here\n}\n',
          tests: [T('totalPrice(1500, 2)', 3000), T('totalPrice(250, 0)', 0), T('totalPrice(99, 3)', 297)], hidden: [H('totalPrice(1, 1)', 1), H('totalPrice(1200, 12)', 14400), H('totalPrice(0.5, 4)', 2)], mustDefine: ['totalPrice'],
          solution: 'function totalPrice(price, quantity) {\n  const total = price * quantity;\n  return total;\n}', hints: ['const total = price * quantity;', 'Then return total;'], explain: 'Store the result in a const, then return it.',
        }),
        codeTask('a5', 'independent', 'A counter that changes', {
          prompt: 'Write a function countUp(start, steps) that returns start plus steps. Inside the function, use let n = start, give n its new value with n = n + steps, then return n. (You will meet loops later in this course.)',
          starter: 'function countUp(start, steps) {\n  let n = start;\n  // your code here\n}\n',
          tests: [T('countUp(0, 3)', 3), T('countUp(10, 5)', 15)], hidden: [H('countUp(7, 0)', 7), H('countUp(-2, 4)', 2), H('countUp(100, 100)', 200)], mustDefine: ['countUp'],
          solution: 'function countUp(start, steps) {\n  let n = start;\n  n = n + steps;\n  return n;\n}', hints: ['n = n + steps;'], explain: 'let allows n to take a new value.',
        }),
      ], 2),
      lesson('l3', 'Values and types', 'By the end of this lesson, you can tell numbers, strings, booleans, undefined and null apart.', 25, [
        teach('t1', 'explanation', 'Kinds of value', [
          'Every value has a type. A number is for counting and maths. A string is text inside quotes. A boolean is true or false. undefined means no value was given yet. null means empty on purpose.',
          'Quotes matter: 5 is a number, "5" is a string. typeof tells you the type of a value.',
        ], { label: 'Example', text: 'typeof 42        // "number"\ntypeof "Ada"     // "string"\ntypeof true      // "boolean"\ntypeof undefined // "undefined"' }, { visual: VIS.jsTypes }),
        choice('a1', 'guided', 'Name the type', 'What does typeof "100" give?', ['"number"', '"string"', '"boolean"'], 1, 'Anything in quotes is a string, even if it looks like a number.', { why: { 0: 'The quotes make it a string.' } }),
        choice('a2', 'guided', 'undefined or null?', 'You declare let city; and give it no value. What is city?', ['null', 'undefined', '""'], 1, 'A variable with no value yet is undefined. null is something you set on purpose.', { hints: ['Nobody gave it anything.'] }),
        fill('a3', 'guided', 'Type the result', 'Type what this shows: console.log(typeof true)', ['boolean', '"boolean"', "'boolean'"], 'true is a boolean.', { hints: ['It is one of: number, string, boolean.'] }),
        codeTask('a4', 'attempt', 'Report the type', {
          prompt: 'Write a function kind(value) that returns the type of value as a string, using typeof.', starter: 'function kind(value) {\n  // your code here\n}\n',
          tests: [T('kind(42)', 'number'), T('kind("hi")', 'string'), T('kind(false)', 'boolean')], hidden: [H('kind(undefined)', 'undefined'), H('kind(3.14)', 'number'), H('kind("")', 'string')], mustDefine: ['kind'],
          solution: 'function kind(value) { return typeof value; }', hints: ['return typeof value;'], explain: 'typeof returns the type as a string.',
        }),
        say('a5', 'Explain it back', 'In your own words, explain the difference between 5 and "5" in JavaScript. You can type it or dictate it.', ['Think about quotes and what you can do with each one.'],
          [{ id: 'number', label: 'Says 5 is a number.' }, { id: 'string', label: 'Says "5" is a string (text).' }, { id: 'diff', label: 'Gives one difference in behaviour or use, such as maths versus text.' }],
          '5 is a number, so you can do maths with it, like 5 + 2 gives 7. "5" is a string, which is text, so "5" + "2" joins the text into "52".', 'One is a number, the other is text.'),
      ], 2),
      lesson('l4', 'Numbers, strings and operators', 'By the end of this lesson, you can calculate with numbers and join strings.', 25, [
        teach('t1', 'explanation', 'Operators', [
          'Arithmetic: + - * / and % (the remainder after division). ** raises to a power. Brackets change the order, just like in school maths.',
          'With strings, + joins text. A template literal uses backticks and ${ } to put a value inside text, which is often clearer than joining.',
        ], { label: 'Example', text: '10 % 3            // 1\n2 ** 3            // 8\n"Hello, " + "Ada" // "Hello, Ada"\nconst name = "Ada";\n`Hello, ${name}!` // "Hello, Ada!"' }),
        choice('a1', 'guided', 'Remainder', 'What is 17 % 5?', ['3', '2', '12'], 1, '17 divided by 5 is 3 with 2 left over. % gives the 2.', { why: { 0: '3 is the whole number of times 5 fits.' } }),
        choice('a2', 'guided', 'Order of operations', 'What is 2 + 3 * 4?', ['20', '14', '24'], 1, 'Multiplication happens before addition: 3 * 4 = 12, then 2 + 12 = 14.', { why: { 0: 'That would be (2 + 3) * 4.' } }),
        choice('a3', 'guided', 'Strings and +', 'What is "7" + 3?', ['10', '"73"', 'error'], 1, 'When one side is a string, + joins them into text: "73".', { hints: ['One side is text.'] }),
        codeTask('a4', 'attempt', 'Is it even?', {
          prompt: 'Write a function isEven(n) that returns true when n is even and false when it is odd. Hint: use %.', starter: 'function isEven(n) {\n  // your code here\n}\n',
          tests: [T('isEven(4)', true), T('isEven(7)', false), T('isEven(0)', true)], hidden: [H('isEven(1001)', false), H('isEven(-2)', true), H('isEven(88)', true)], mustDefine: ['isEven'],
          solution: 'function isEven(n) { return n % 2 === 0; }', hints: ['An even number has remainder 0 when divided by 2.', 'return n % 2 === 0;'], explain: 'n % 2 is 0 for every even number.',
        }),
        codeTask('a5', 'independent', 'Greeting', {
          prompt: 'Write a function greet(name) that returns "Hello, " followed by the name and an exclamation mark. greet("Ada") returns "Hello, Ada!".', starter: 'function greet(name) {\n  // your code here\n}\n',
          tests: [T('greet("Ada")', 'Hello, Ada!'), T('greet("Tobi")', 'Hello, Tobi!')], hidden: [H('greet("Zainab")', 'Hello, Zainab!'), H('greet("")', 'Hello, !')], mustDefine: ['greet'],
          solution: 'function greet(name) { return `Hello, ${name}!`; }', hints: ['Use + to join, or a template literal with backticks.'], explain: 'Either "Hello, " + name + "!" or a template literal works.',
        }),
      ], 2),
    ]),
    // ───────────────────────────── 2 ─────────────────────────────
    section('s2', 'Making decisions', 'Make a program choose what to do.', [
      lesson('l1', 'Comparisons and booleans', 'By the end of this lesson, you can write comparisons that produce true or false.', 20, [
        teach('t1', 'explanation', 'Questions with yes or no answers', [
          'A comparison asks a question and gives a boolean. === means equal, !== not equal, then < > <= >=. Use three equals signs: === compares values. A single = stores a value.',
          'Comparing a number with text can surprise you. Use === so that 5 and "5" are not treated as the same.',
        ], { label: 'Example', text: '5 > 3        // true\n5 === "5"    // false\n10 !== 10    // false\n7 <= 7       // true' }),
        choice('a1', 'guided', 'True or false', 'What is 8 >= 8?', ['true', 'false'], 0, '>= means greater than or equal. 8 is equal to 8.', { hints: ['Equal counts.'] }),
        choice('a2', 'guided', 'One equals or three?', 'Which line compares x with 5?', ['x = 5', 'x === 5'], 1, '= stores a value. === compares two values.', { why: { 0: 'x = 5 would store 5 in x.' } }),
        fill('a3', 'guided', 'Complete it', 'Type what this shows: console.log(3 + 2 === 5)', ['true'], '3 + 2 is 5, so the comparison is true.', { hints: ['Work out the left side first.'] }),
        codeTask('a4', 'attempt', 'Can they vote?', {
          prompt: 'Write a function canVote(age) that returns true when age is 18 or more.', starter: 'function canVote(age) {\n  // your code here\n}\n',
          tests: [T('canVote(18)', true), T('canVote(17)', false), T('canVote(40)', true)], hidden: [H('canVote(0)', false), H('canVote(19)', true), H('canVote(17.9)', false)], mustDefine: ['canVote'],
          solution: 'function canVote(age) { return age >= 18; }', hints: ['return age >= 18;'], explain: 'The comparison itself is a boolean, so it can be returned directly.',
        }),
      ]),
      lesson('l2', 'if and else', 'By the end of this lesson, you can choose between two paths with if and else.', 25, [
        teach('t1', 'explanation', 'if runs code only when a condition is true', [
          'if (condition) { ... } runs the block only when the condition is true. Add else { ... } for the other case. Exactly one of the two blocks runs.',
          'To test more cases use else if. The first condition that is true wins, and the rest are skipped.',
        ], { label: 'Example', text: 'function grade(score) {\n  if (score >= 70) {\n    return "A";\n  } else if (score >= 50) {\n    return "B";\n  } else {\n    return "C";\n  }\n}' }, { visual: VIS.jsIfFlow }),
        choice('a1', 'guided', 'Which branch?', 'With score = 55, what does the grade() function above return?', ['"A"', '"B"', '"C"'], 1, '55 is not >= 70, but it is >= 50, so the else if branch runs and returns "B".', { hints: ['Check the conditions from the top.'] }),
        choice('a2', 'guided', 'Order matters', 'This code always returns "low" for any score of 40 or more. What is wrong?\n\nif (score >= 40) return "low";\nelse if (score >= 70) return "high";', ['The comparison operator', 'The conditions are in the wrong order', 'Missing brackets'], 1, 'A score of 80 matches >= 40 first, so the second test is never reached. Test the most specific condition first.', { hints: ['Which test should come first for a score of 80?'] }),
        codeTask('a3', 'attempt', 'Pass or fail', {
          prompt: 'Write a function result(score) that returns "pass" when score is 50 or more and "fail" otherwise.', starter: 'function result(score) {\n  // your code here\n}\n',
          tests: [T('result(50)', 'pass'), T('result(49)', 'fail'), T('result(100)', 'pass')], hidden: [H('result(0)', 'fail'), H('result(75)', 'pass'), H('result(49.5)', 'fail')], mustDefine: ['result'],
          solution: 'function result(score) {\n  if (score >= 50) {\n    return "pass";\n  } else {\n    return "fail";\n  }\n}', hints: ['if (score >= 50) { return "pass"; }'], explain: 'Return in each branch. Only one branch runs.',
        }),
        codeTask('a4', 'independent', 'Sign of a number', {
          prompt: 'Write a function sign(n) that returns "positive" for numbers above 0, "negative" for numbers below 0 and "zero" for 0.', starter: 'function sign(n) {\n  // your code here\n}\n',
          tests: [T('sign(5)', 'positive'), T('sign(-2)', 'negative'), T('sign(0)', 'zero')], hidden: [H('sign(0.01)', 'positive'), H('sign(-100)', 'negative'), H('sign(999)', 'positive')], mustDefine: ['sign'],
          solution: 'function sign(n) {\n  if (n > 0) return "positive";\n  if (n < 0) return "negative";\n  return "zero";\n}', hints: ['Use if, else if and else.'], explain: 'Three cases need an else if, or two ifs and a final return.',
        }),
      ]),
      lesson('l3', 'Combining conditions', 'By the end of this lesson, you can combine tests with && (and), || (or) and ! (not).', 25, [
        teach('t1', 'explanation', 'And, or, not', [
          'a && b is true only when both are true. a || b is true when at least one is true. !a flips true to false and false to true.',
          'Combine them with brackets to be clear. Use them to check a number is in a range, or that text matches one of several allowed values.',
        ], { label: 'Example', text: 'const age = 15;\nage >= 13 && age <= 19  // true: a teenager\nage < 5 || age > 65     // false\n!(age >= 18)            // true' }),
        choice('a1', 'guided', 'and', 'What is true && false?', ['true', 'false'], 1, '&& needs both sides to be true.'),
        choice('a2', 'guided', 'or', 'What is (3 > 5) || (2 === 2)?', ['true', 'false'], 0, 'The left side is false but the right side is true, and || only needs one.'),
        choice('a3', 'guided', 'not', 'What is !(4 < 2)?', ['true', 'false'], 0, '4 < 2 is false. ! flips it to true.'),
        codeTask('a4', 'attempt', 'In range', {
          prompt: 'Write a function inRange(n, low, high) that returns true when n is between low and high, including both ends.', starter: 'function inRange(n, low, high) {\n  // your code here\n}\n',
          tests: [T('inRange(5, 1, 10)', true), T('inRange(0, 1, 10)', false), T('inRange(10, 1, 10)', true)], hidden: [H('inRange(1, 1, 10)', true), H('inRange(11, 1, 10)', false), H('inRange(-5, -10, -1)', true)], mustDefine: ['inRange'],
          solution: 'function inRange(n, low, high) { return n >= low && n <= high; }', hints: ['Both tests must be true: n is at least low and at most high.'], explain: '&& joins the two comparisons.',
        }),
        codeTask('a5', 'independent', 'Weekend', {
          prompt: 'Write a function isWeekend(day) that returns true for "Saturday" and "Sunday" and false for anything else.', starter: 'function isWeekend(day) {\n  // your code here\n}\n',
          tests: [T('isWeekend("Saturday")', true), T('isWeekend("Monday")', false)], hidden: [H('isWeekend("Sunday")', true), H('isWeekend("Friday")', false), H('isWeekend("")', false)], mustDefine: ['isWeekend'],
          solution: 'function isWeekend(day) { return day === "Saturday" || day === "Sunday"; }', hints: ['Compare day with each name, joined by ||.'], explain: 'Each comparison needs the full form: day === "Saturday" || day === "Sunday".',
        }),
      ]),
    ]),
    // ───────────────────────────── 3 ─────────────────────────────
    section('s3', 'Functions', 'Package logic so you can reuse it.', [
      lesson('l1', 'Writing functions', 'By the end of this lesson, you can define a function and call it.', 20, [
        teach('t1', 'explanation', 'Define once, use many times', [
          'A function groups steps under a name. Define it with function name(parameters) { ... }, then call it with name(arguments). Calling a function runs its body.',
          'A function that does not return anything gives back undefined.',
        ], { label: 'Example', text: 'function double(n) {\n  return n * 2;\n}\ndouble(4); // 8\ndouble(21); // 42' }, { visual: VIS.jsFunction }),
        choice('a1', 'guided', 'What does it return?', 'What does this return?\n\nfunction f(x) {\n  x * 2;\n}\nf(5);', ['10', 'undefined', '5'], 1, 'There is no return, so the function gives back undefined even though x * 2 was calculated.', { hints: ['Look for the word return.'] }),
        choice('a2', 'guided', 'Define or call?', 'Which line calls the function?', ['function add(a, b) { return a + b; }', 'add(2, 3);'], 1, 'The first line defines it. The second runs it.'),
        codeTask('a3', 'attempt', 'Square', {
          prompt: 'Write a function square(n) that returns n multiplied by itself.', starter: 'function square(n) {\n  // your code here\n}\n',
          tests: [T('square(3)', 9), T('square(0)', 0), T('square(-4)', 16)], hidden: [H('square(12)', 144), H('square(1.5)', 2.25)], mustDefine: ['square'],
          solution: 'function square(n) { return n * n; }', hints: ['return n * n;'], explain: 'Multiply n by itself and return it.',
        }),
        codeTask('a4', 'independent', 'Perimeter', {
          prompt: 'Write a function perimeter(width, height) that returns the perimeter of a rectangle.', starter: 'function perimeter(width, height) {\n  // your code here\n}\n',
          tests: [T('perimeter(3, 4)', 14), T('perimeter(10, 10)', 40)], hidden: [H('perimeter(0, 5)', 10), H('perimeter(2.5, 1)', 7)], mustDefine: ['perimeter'],
          solution: 'function perimeter(width, height) { return 2 * (width + height); }', hints: ['Two widths and two heights.'], explain: '2 * (width + height).',
        }),
      ]),
      lesson('l2', 'Parameters and return values', 'By the end of this lesson, you can write functions that take several inputs and make decisions before returning.', 25, [
        teach('t1', 'explanation', 'Several inputs, one result', [
          'Parameters are separated by commas. The caller passes arguments in the same order. A function can call other functions, which keeps each one small.',
          'return ends the function immediately. Code after a return never runs. A default parameter, such as rate = 0.1, is used when no argument is given.',
        ], { label: 'Example', text: 'function discount(price, rate = 0.1) {\n  return price - price * rate;\n}\ndiscount(1000);       // 900\ndiscount(1000, 0.25); // 750' }),
        choice('a1', 'guided', 'Default value', 'With the discount function above, what does discount(200) return?', ['200', '180', '20'], 1, 'The default rate is 0.1, so 200 - 20 = 180.'),
        choice('a2', 'guided', 'Early return', 'What does this return?\n\nfunction f() {\n  return 1;\n  return 2;\n}', ['1', '2', '3'], 0, 'The function ends at the first return. The second line never runs.'),
        codeTask('a3', 'attempt', 'Maximum of two', {
          prompt: 'Write a function larger(a, b) that returns the bigger of two numbers. Do not use Math.max.', starter: 'function larger(a, b) {\n  // your code here\n}\n',
          tests: [T('larger(3, 7)', 7), T('larger(9, 2)', 9), T('larger(5, 5)', 5)], hidden: [H('larger(-1, -9)', -1), H('larger(0, -3)', 0), H('larger(100, 101)', 101)], mustDefine: ['larger'],
          solution: 'function larger(a, b) {\n  if (a > b) return a;\n  return b;\n}', hints: ['Use if to compare a and b.'], explain: 'Return a when it is bigger, otherwise b.',
        }),
        codeTask('a4', 'independent', 'Final price', {
          prompt: 'Write a function finalPrice(price, quantity, discountRate = 0) that returns the total after the discount. For example finalPrice(100, 2, 0.1) is 180.', starter: 'function finalPrice(price, quantity, discountRate = 0) {\n  // your code here\n}\n',
          tests: [T('finalPrice(100, 2, 0.1)', 180), T('finalPrice(50, 3)', 150)], hidden: [H('finalPrice(1000, 1, 0.5)', 500), H('finalPrice(20, 5, 0)', 100), H('finalPrice(10, 10, 0.2)', 80)], mustDefine: ['finalPrice'],
          solution: 'function finalPrice(price, quantity, discountRate = 0) {\n  const subtotal = price * quantity;\n  return subtotal - subtotal * discountRate;\n}', hints: ['Work out price * quantity first.'], explain: 'Subtract the discount from the subtotal.',
        }),
      ]),
      lesson('l3', 'Scope', 'By the end of this lesson, you can say where a variable can be used.', 20, [
        teach('t1', 'explanation', 'Where a name can be seen', [
          'A variable declared inside a function exists only inside that function. A variable declared inside a block (curly brackets) with let or const exists only inside that block.',
          'Inner code can read variables from outside it. Outer code cannot read variables from inside. Using a name outside its scope causes a ReferenceError.',
        ], { label: 'Example', text: 'const school = "Fahmid";\nfunction hello() {\n  const name = "Ada";\n  return school + " " + name; // fine\n}\nconsole.log(name); // ReferenceError' }, { visual: VIS.jsScope }),
        choice('a1', 'guided', 'Can it be seen?', 'Which line causes an error?\n\nfunction f() {\n  const secret = 7;\n}\nf();\nconsole.log(secret);', ['f();', 'console.log(secret);', 'const secret = 7;'], 1, 'secret exists only inside f. Outside the function the name is not defined.'),
        choice('a2', 'guided', 'Inner can read outer', 'What does this return?\n\nconst rate = 0.5;\nfunction half(n) { return n * rate; }\nhalf(10);', ['5', '10', 'error'], 0, 'A function can read variables declared outside it. rate is 0.5, so the result is 5.'),
        codeTask('a3', 'attempt', 'Fix the scope', {
          prompt: 'The function below fails because total is declared inside the if block. Fix it so it returns the right result. cost(2) should be 20 and cost(5) should be 50.',
          starter: 'function cost(items) {\n  if (items > 0) {\n    let total = items * 10;\n  }\n  return total;\n}\n',
          tests: [T('cost(2)', 20), T('cost(5)', 50), T('cost(0)', 0)], hidden: [H('cost(1)', 10), H('cost(12)', 120)], mustDefine: ['cost'],
          solution: 'function cost(items) {\n  let total = 0;\n  if (items > 0) {\n    total = items * 10;\n  }\n  return total;\n}', hints: ['Declare total outside the if block, then change it inside.'], explain: 'Declare with let before the block, then assign inside.',
        }),
      ]),
      lesson('l4', 'Arrow functions', 'By the end of this lesson, you can write the same function in the shorter arrow form.', 15, [
        teach('t1', 'explanation', 'A shorter way to write a function', [
          'An arrow function uses => instead of the word function. If the body is a single expression, you can drop the curly brackets and the word return.',
          'Arrow functions are common in modern code, especially when you pass a function to another function, as you will in the lists section.',
        ], { label: 'Example', text: 'const double = (n) => n * 2;\nconst add = (a, b) => a + b;\nconst greet = (name) => {\n  const text = "Hi " + name;\n  return text;\n};' }),
        choice('a1', 'guided', 'Same thing', 'Which function does the same as function f(n) { return n + 1; } ?', ['const f = (n) => n + 1;', 'const f = n => { n + 1 };'], 0, 'With curly brackets you must write return. The first form returns n + 1 automatically.', { why: { 1: 'With braces there is no automatic return, so this gives undefined.' } }),
        codeTask('a2', 'attempt', 'Arrow it', {
          prompt: 'Define a constant half as an arrow function that returns a number divided by 2. half(10) is 5.', starter: 'const half = // your code here\n',
          tests: [T('half(10)', 5), T('half(3)', 1.5)], hidden: [H('half(0)', 0), H('half(-8)', -4)], mustDefine: ['half'],
          solution: 'const half = (n) => n / 2;', hints: ['const half = (n) => ...'], explain: 'An arrow function with one expression returns it automatically.',
        }),
      ]),
    ]),
    // ───────────────────────────── 4 ─────────────────────────────
    section('s4', 'Lists and loops', 'Work with many values at once.', [
      lesson('l1', 'Arrays', 'By the end of this lesson, you can create an array, read items by index and change it.', 25, [
        teach('t1', 'explanation', 'An ordered list', [
          'An array holds many values in order. Write it in square brackets. Each item has an index, starting at 0. The length property tells you how many items there are, so the last index is length - 1.',
          'push adds to the end. pop removes the last item. includes checks if a value is in the array. Reading outside the array gives undefined.',
        ], { label: 'Example', text: 'const names = ["Ada", "Tobi", "Zainab"];\nnames[0];           // "Ada"\nnames.length;       // 3\nnames.push("Kemi"); // now 4 items\nnames.includes("Tobi"); // true' }, { visual: VIS.jsArray }),
        choice('a1', 'guided', 'First item', 'What is items[1] if items = ["a", "b", "c"]?', ['"a"', '"b"', '"c"'], 1, 'Indexes start at 0, so index 1 is the second item.', { hints: ['Count from 0.'] }),
        choice('a2', 'guided', 'Last index', 'An array has 6 items. What is the index of the last item?', ['6', '5', '7'], 1, 'Indexes run from 0 to length - 1, so the last index is 5.'),
        codeTask('a3', 'attempt', 'Last item', {
          prompt: 'Write a function last(list) that returns the last item of an array.', starter: 'function last(list) {\n  // your code here\n}\n',
          tests: [T('last([1, 2, 3])', 3), T('last(["a"])', 'a')], hidden: [H('last([5, 9, 12, 40])', 40), H('last(["x", "y"])', 'y')], mustDefine: ['last'],
          solution: 'function last(list) { return list[list.length - 1]; }', hints: ['The last index is list.length - 1.'], explain: 'Use length minus one as the index.',
        }),
        codeTask('a4', 'independent', 'Sum', {
          prompt: 'Write a function sumOfThree(list) that returns the sum of the first three items. You may assume the array has at least three items.', starter: 'function sumOfThree(list) {\n  // your code here\n}\n',
          tests: [T('sumOfThree([1, 2, 3, 99])', 6), T('sumOfThree([10, 20, 30])', 60)], hidden: [H('sumOfThree([0, 0, 0])', 0), H('sumOfThree([-1, 1, 5, 5])', 5)], mustDefine: ['sumOfThree'],
          solution: 'function sumOfThree(list) { return list[0] + list[1] + list[2]; }', hints: ['Add list[0], list[1] and list[2].'], explain: 'Index each item and add them.',
        }),
      ]),
      lesson('l2', 'Loops', 'By the end of this lesson, you can repeat work with for and while loops.', 30, [
        teach('t1', 'explanation', 'Repeat without copying code', [
          'A for loop has three parts: a start, a test and an update. The loop runs the body while the test is true. for (let i = 0; i < 3; i++) runs with i = 0, 1 and 2.',
          'To go through an array, loop i from 0 to list.length - 1. A for...of loop is a shorter way when you do not need the index. A while loop repeats while a condition is true, so make sure something inside changes it, or the loop never ends.',
        ], { label: 'Example', text: 'let total = 0;\nfor (const n of [4, 6, 10]) {\n  total = total + n;\n}\n// total is 20' }, { visual: VIS.jsLoop }),
        choice('a1', 'guided', 'How many times?', 'How many times does this loop run?\n\nfor (let i = 0; i < 4; i++) { ... }', ['3', '4', '5'], 1, 'i takes the values 0, 1, 2 and 3. At 4 the test is false.', { hints: ['List the values of i.'] }),
        choice('a2', 'guided', 'Endless loop', 'Why does this loop never end?\n\nlet i = 0;\nwhile (i < 3) {\n  console.log(i);\n}', ['The test is wrong', 'i is never changed', 'console.log stops it'], 1, 'Nothing changes i, so i < 3 stays true forever. Add i++ inside the loop.'),
        codeTask('a3', 'attempt', 'Total', {
          prompt: 'Write a function total(list) that returns the sum of all numbers in the array. The sum of an empty array is 0.', starter: 'function total(list) {\n  // your code here\n}\n',
          tests: [T('total([1, 2, 3])', 6), T('total([])', 0), T('total([10])', 10)], hidden: [H('total([5, 5, 5, 5])', 20), H('total([-3, 3])', 0), H('total([100, 200, 300, 400])', 1000)], mustDefine: ['total'],
          solution: 'function total(list) {\n  let sum = 0;\n  for (const n of list) {\n    sum = sum + n;\n  }\n  return sum;\n}', hints: ['Start with let sum = 0, then add each item.'], explain: 'A running total starts at 0 and grows inside the loop.',
        }),
        codeTask('a4', 'independent', 'Count matches', {
          prompt: 'Write a function countAbove(list, limit) that returns how many items in the array are greater than limit.', starter: 'function countAbove(list, limit) {\n  // your code here\n}\n',
          tests: [T('countAbove([1, 5, 8, 10], 4)', 3), T('countAbove([], 3)', 0)], hidden: [H('countAbove([2, 2, 2], 2)', 0), H('countAbove([9, 8, 7], 0)', 3), H('countAbove([-1, 0, 1], -1)', 2)], mustDefine: ['countAbove'],
          solution: 'function countAbove(list, limit) {\n  let count = 0;\n  for (const n of list) {\n    if (n > limit) count = count + 1;\n  }\n  return count;\n}', hints: ['Keep a counter and add 1 when the test is true.'], explain: 'A counter plus an if inside the loop.',
        }),
        codeTask('a5', 'independent', 'Countdown text', {
          prompt: 'Write a function countdown(n) that returns the numbers from n down to 1 joined by a space, then the word "go". countdown(3) returns "3 2 1 go".', starter: 'function countdown(n) {\n  // your code here\n}\n',
          tests: [T('countdown(3)', '3 2 1 go'), T('countdown(1)', '1 go')], hidden: [H('countdown(5)', '5 4 3 2 1 go'), H('countdown(0)', 'go')], mustDefine: ['countdown'],
          solution: 'function countdown(n) {\n  let text = "";\n  for (let i = n; i >= 1; i--) {\n    text = text + i + " ";\n  }\n  return text + "go";\n}', hints: ['Loop i from n down to 1 with i--.'], explain: 'Count down with i--, building the text as you go.',
        }),
      ]),
      lesson('l3', 'map, filter and reduce', 'By the end of this lesson, you can transform, select and combine array items.', 30, [
        teach('t1', 'explanation', 'Three tools for lists', [
          'map(fn) returns a new array where every item has been changed by fn. filter(fn) returns a new array with only the items for which fn returns true. reduce(fn, start) combines all items into one value.',
          'None of them changes the original array. They return a new result, which you store in a variable.',
        ], { label: 'Example', text: 'const nums = [2, 4, 6];\nnums.map((n) => n * 10);          // [20, 40, 60]\nnums.filter((n) => n > 3);        // [4, 6]\nnums.reduce((sum, n) => sum + n, 0); // 12' }, { visual: VIS.jsPipeline }),
        choice('a1', 'guided', 'Which tool?', 'You have a list of prices and want every price with 10% added. Which method fits?', ['filter', 'map', 'reduce'], 1, 'You are changing every item into a new value, which is map.', { hints: ['Every item changes. Nothing is dropped.'] }),
        choice('a2', 'guided', 'What comes out?', 'What is [1, 2, 3, 4].filter((n) => n % 2 === 0)?', ['[1, 3]', '[2, 4]', '[false, true, false, true]'], 1, 'filter keeps the items for which the test is true: 2 and 4.', { why: { 2: 'That would be map with the test. filter keeps the original items.' } }),
        codeTask('a3', 'attempt', 'Map', {
          prompt: 'Write a function lengths(words) that returns an array with the length of every word. lengths(["hi", "code"]) is [2, 4].', starter: 'function lengths(words) {\n  // your code here\n}\n',
          tests: [T('lengths(["hi", "code"])', [2, 4]), T('lengths([])', [])], hidden: [H('lengths(["a", "bb", "ccc"])', [1, 2, 3]), H('lengths([""])', [0])], mustDefine: ['lengths'],
          solution: 'function lengths(words) { return words.map((w) => w.length); }', hints: ['words.map((w) => ...)'], explain: 'map turns each word into its length.',
        }),
        codeTask('a4', 'attempt', 'Filter', {
          prompt: 'Write a function passes(scores) that returns only the scores that are 50 or more.', starter: 'function passes(scores) {\n  // your code here\n}\n',
          tests: [T('passes([40, 50, 90])', [50, 90]), T('passes([10, 20])', [])], hidden: [H('passes([49, 51, 100, 0])', [51, 100]), H('passes([])', [])], mustDefine: ['passes'],
          solution: 'function passes(scores) { return scores.filter((s) => s >= 50); }', hints: ['scores.filter((s) => s >= 50)'], explain: 'filter keeps only the scores that pass the test.',
        }),
        codeTask('a5', 'independent', 'Reduce', {
          prompt: 'Write a function average(scores) that returns the average of an array of numbers. Use reduce for the total. For an empty array return 0.', starter: 'function average(scores) {\n  // your code here\n}\n',
          tests: [T('average([10, 20, 30])', 20), T('average([])', 0), T('average([5])', 5)], hidden: [H('average([1, 2])', 1.5), H('average([70, 80, 90, 100])', 85), H('average([0, 0, 0])', 0)], mustDefine: ['average'],
          solution: 'function average(scores) {\n  if (scores.length === 0) return 0;\n  const sum = scores.reduce((s, n) => s + n, 0);\n  return sum / scores.length;\n}', hints: ['Deal with the empty array first.', 'Divide the total by scores.length.'], explain: 'reduce gives the total. Divide by the count.',
        }),
      ]),
    ]),
    // ───────────────────────────── 5 ─────────────────────────────
    section('s5', 'Objects and text', 'Describe real things and work with words.', [
      lesson('l1', 'Objects', 'By the end of this lesson, you can create an object and read and change its properties.', 25, [
        teach('t1', 'explanation', 'Named facts together', [
          'An object groups related values under names (keys). Write it in curly brackets: key: value, separated by commas. Read a property with a dot, or with square brackets when the key is in a variable.',
          'Assigning to a property changes it. Assigning to a new key adds it. Object.keys(obj) gives an array of the keys.',
        ], { label: 'Example', text: 'const pupil = { name: "Ada", age: 12, scores: [70, 82, 91] };\npupil.name;        // "Ada"\npupil["age"];      // 12\npupil.age = 13;    // change\npupil.class = "JSS 1"; // add' }, { visual: VIS.jsObject }),
        choice('a1', 'guided', 'Read a property', 'What is pupil.scores[1] for the object above?', ['70', '82', '91'], 1, 'pupil.scores is the array, and index 1 is the second item, 82.'),
        choice('a2', 'guided', 'Dot or brackets', 'The key name is stored in a variable called field. Which reads it?', ['pupil.field', 'pupil[field]'], 1, 'pupil.field looks for a key literally called "field". Brackets use the variable value.'),
        codeTask('a3', 'attempt', 'Build an object', {
          prompt: 'Write a function makePupil(name, age) that returns an object with the keys name and age.', starter: 'function makePupil(name, age) {\n  // your code here\n}\n',
          tests: [T('makePupil("Ada", 12)', { name: 'Ada', age: 12 }), T('makePupil("Tobi", 9)', { name: 'Tobi', age: 9 })], hidden: [H('makePupil("Zainab", 15)', { name: 'Zainab', age: 15 }), H('makePupil("", 0)', { name: '', age: 0 })], mustDefine: ['makePupil'],
          solution: 'function makePupil(name, age) { return { name: name, age: age }; }', hints: ['return { name: name, age: age };'], explain: 'An object literal with two keys.',
        }),
        codeTask('a4', 'independent', 'Birthday', {
          prompt: 'Write a function birthday(person) that returns a new object with the same name and an age one higher. Do not change the original: return a new object.', starter: 'function birthday(person) {\n  // your code here\n}\n',
          tests: [T('birthday({ name: "Ada", age: 12 })', { name: 'Ada', age: 13 })], hidden: [H('birthday({ name: "Tobi", age: 0 })', { name: 'Tobi', age: 1 }), H('birthday({ name: "Kemi", age: 40 })', { name: 'Kemi', age: 41 })], mustDefine: ['birthday'],
          solution: 'function birthday(person) { return { name: person.name, age: person.age + 1 }; }', hints: ['Build a new object using person.name and person.age + 1.'], explain: 'Reading properties and building a fresh object.',
        }),
      ]),
      lesson('l2', 'Working with strings', 'By the end of this lesson, you can use common string methods.', 25, [
        teach('t1', 'explanation', 'Methods on text', [
          'Strings have properties and methods. length counts characters. toUpperCase and toLowerCase change case. trim removes spaces at both ends. includes checks for a piece of text. split(separator) turns a string into an array. join(separator) turns an array back into a string.',
          'Strings cannot be changed in place. Every method returns a new string.',
        ], { label: 'Example', text: '"  Ada  ".trim();            // "Ada"\n"a,b,c".split(",");          // ["a", "b", "c"]\n["a", "b"].join("-");         // "a-b"\n"Lagos".includes("ag");      // true' }),
        choice('a1', 'guided', 'What is shown?', 'What does "code".toUpperCase() return?', ['"Code"', '"CODE"', '"code"'], 1, 'toUpperCase makes every letter a capital.'),
        choice('a2', 'guided', 'split', 'What is "a b c".split(" ")?', ['["a b c"]', '["a", "b", "c"]', '"abc"'], 1, 'split(" ") breaks the text at each space and returns the parts as an array.'),
        codeTask('a3', 'attempt', 'Count words', {
          prompt: 'Write a function wordCount(text) that returns the number of words in text. Words are separated by single spaces and there are no leading or trailing spaces. An empty string has 0 words.', starter: 'function wordCount(text) {\n  // your code here\n}\n',
          tests: [T('wordCount("one two three")', 3), T('wordCount("hello")', 1), T('wordCount("")', 0)], hidden: [H('wordCount("a b c d e f")', 6), H('wordCount("Lagos")', 1)], mustDefine: ['wordCount'],
          solution: 'function wordCount(text) {\n  if (text === "") return 0;\n  return text.split(" ").length;\n}', hints: ['split(" ") gives an array. An empty string needs a special case.'], explain: '"".split(" ") gives [""], which has length 1, so handle empty text first.',
        }),
        codeTask('a4', 'independent', 'Title case', {
          prompt: 'Write a function capitalise(word) that returns the word with its first letter in capitals and the rest in lowercase. capitalise("aDA") returns "Ada". For an empty string return "".', starter: 'function capitalise(word) {\n  // your code here\n}\n',
          tests: [T('capitalise("aDA")', 'Ada'), T('capitalise("lagos")', 'Lagos'), T('capitalise("")', '')], hidden: [H('capitalise("TOBI")', 'Tobi'), H('capitalise("z")', 'Z')], mustDefine: ['capitalise'],
          solution: 'function capitalise(word) {\n  if (word === "") return "";\n  return word[0].toUpperCase() + word.slice(1).toLowerCase();\n}', hints: ['word[0] is the first letter. word.slice(1) is the rest.'], explain: 'Change the first letter and the rest separately, then join them.',
        }),
      ]),
      lesson('l3', 'Arrays of objects', 'By the end of this lesson, you can process lists of objects such as a class register.', 30, [
        teach('t1', 'explanation', 'Real data is lists of objects', [
          'Most real data is an array of objects: pupils, products, orders. You can use all the array tools on them. Read the property you need inside the function you pass in.',
          'Chain methods: filter first, then map. Each step returns an array, so you can call the next method straight away.',
        ], { label: 'Example', text: 'const pupils = [\n  { name: "Ada", score: 82 },\n  { name: "Tobi", score: 45 },\n];\npupils.filter((p) => p.score >= 50).map((p) => p.name); // ["Ada"]' }),
        choice('a1', 'guided', 'Reading a property', 'What is pupils[1].name for the array above?', ['"Ada"', '"Tobi"', '45'], 1, 'pupils[1] is the second object, and .name is "Tobi".'),
        codeTask('a2', 'attempt', 'Names only', {
          prompt: 'Write a function names(people) that returns an array of the name of every person.', starter: 'function names(people) {\n  // your code here\n}\n',
          tests: [T('names([{ name: "Ada" }, { name: "Tobi" }])', ['Ada', 'Tobi']), T('names([])', [])], hidden: [H('names([{ name: "Kemi", age: 3 }])', ['Kemi'])], mustDefine: ['names'],
          solution: 'function names(people) { return people.map((p) => p.name); }', hints: ['people.map((p) => p.name)'], explain: 'map turns each person into their name.',
        }),
        codeTask('a3', 'independent', 'Who passed?', {
          prompt: 'Write a function passedNames(pupils) that returns the names of the pupils whose score is 50 or more.', starter: 'function passedNames(pupils) {\n  // your code here\n}\n',
          tests: [T('passedNames([{ name: "Ada", score: 82 }, { name: "Tobi", score: 45 }])', ['Ada'])], hidden: [H('passedNames([{ name: "A", score: 50 }, { name: "B", score: 49 }, { name: "C", score: 90 }])', ['A', 'C']), H('passedNames([])', [])], mustDefine: ['passedNames'],
          solution: 'function passedNames(pupils) { return pupils.filter((p) => p.score >= 50).map((p) => p.name); }', hints: ['filter first, then map to names.'], explain: 'Chain filter and map.',
        }),
        codeTask('a4', 'independent', 'Top scorer', {
          prompt: 'Write a function topScorer(pupils) that returns the name of the pupil with the highest score. You may assume the array has at least one pupil and no ties.', starter: 'function topScorer(pupils) {\n  // your code here\n}\n',
          tests: [T('topScorer([{ name: "Ada", score: 82 }, { name: "Tobi", score: 91 }])', 'Tobi')], hidden: [H('topScorer([{ name: "A", score: 10 }])', 'A'), H('topScorer([{ name: "A", score: 70 }, { name: "B", score: 60 }, { name: "C", score: 65 }])', 'A')], mustDefine: ['topScorer'],
          solution: 'function topScorer(pupils) {\n  let best = pupils[0];\n  for (const p of pupils) {\n    if (p.score > best.score) best = p;\n  }\n  return best.name;\n}', hints: ['Keep the best pupil so far and compare each one with it.'], explain: 'A loop that remembers the best item seen so far.',
        }),
      ]),
    ]),
    // ───────────────────────────── 6 ─────────────────────────────
    section('s6', 'Build and check', 'Debug with a method, prove what you know, then build a real program.', [
      lesson('l1', 'Debugging', 'By the end of this lesson, you can find and fix a bug with a method instead of guessing.', 25, [
        teach('t1', 'explanation', 'Debugging is a loop', [
          'Every programmer meets bugs. Do not guess. Reproduce the problem, read the error message and the line number, narrow down where the value goes wrong with console.log, fix one thing, and test again.',
          'Common errors: a ReferenceError means a name is not defined (often a typo or a scope problem). A TypeError means you used a value in a way its type does not allow, such as calling a method on undefined. A wrong answer with no error is a logic bug: check your conditions and your loop limits.',
        ], { label: 'Example', text: 'function avg(list) {\n  let sum = 0;\n  for (const n of list) sum += n;\n  return sum / list.length - 1; // bug: the - 1 is wrong\n}' }, { visual: VIS.jsDebug }),
        choice('a1', 'guided', 'Which error?', 'You call user.name but user is undefined. Which error is this?', ['ReferenceError', 'TypeError', 'SyntaxError'], 1, 'The name user exists, but undefined has no property to read. That is a TypeError.', { why: { 0: 'ReferenceError means the name itself does not exist.' } }),
        choice('a2', 'guided', 'First step', 'A function gives the wrong answer for one input. What do you do first?', ['Rewrite the whole function', 'Run it with that exact input and print the values', 'Change several lines at once'], 1, 'Reproduce it and look at the real values. Guessing and changing many things hides the cause.'),
        codeTask('a3', 'attempt', 'Fix the bug', {
          prompt: 'This function should return the largest number in an array, but it gives the wrong answer. Fix it. biggest([3, 9, 4]) should be 9.',
          starter: 'function biggest(list) {\n  let max = 0;\n  for (const n of list) {\n    if (n < max) max = n;\n  }\n  return max;\n}\n',
          tests: [T('biggest([3, 9, 4])', 9), T('biggest([1])', 1), T('biggest([-5, -2, -9])', -2)], hidden: [H('biggest([10, 2, 7])', 10), H('biggest([-1, -1])', -1)], mustDefine: ['biggest'],
          solution: 'function biggest(list) {\n  let max = list[0];\n  for (const n of list) {\n    if (n > max) max = n;\n  }\n  return max;\n}', hints: ['There are two bugs. Check the starting value, and the comparison.'], explain: 'Start from the first item, and replace max when you find something larger. Starting at 0 fails for negative numbers.',
        }),
        say('a4', 'Describe your method', 'Describe the steps you would follow when a function returns the wrong answer. You can type it or dictate it.', ['Use the order from this lesson.'],
          [{ id: 'repro', label: 'Mentions repeating or reproducing the problem with a specific input.' }, { id: 'inspect', label: 'Mentions reading the error or checking values, for example with console.log.' }, { id: 'one', label: 'Mentions changing one thing at a time and testing again.' }],
          'First I run the function with the input that fails. I read any error message and print the values with console.log to see where they go wrong. Then I change one thing, and run the same input again to check.', 'Reproduce, inspect, change one thing, test again.', 15),
      ]),
      lesson('l2', 'Final assessment', 'By the end of this assessment, you can show that you can use every idea in this course. You need 75% to pass.', 40, [
        teach('t1', 'introduction', 'Before you begin', ['This is an assessment. Your tutor can explain what a question is asking but will not help you answer it. You have three tries on each question. Take your time.']),
        choice('f1', 'checkpoint', 'Types', 'What is typeof [1, 2]?', ['"array"', '"object"', '"list"'], 1, 'Arrays are a kind of object in JavaScript, so typeof gives "object".', { hints: [] }),
        choice('f2', 'checkpoint', 'Const', 'What happens here?\n\nconst items = [1, 2];\nitems.push(3);', ['An error, because items is const', 'It works: items becomes [1, 2, 3]', 'items stays [1, 2]'], 1, 'const stops you from pointing the name at a new value. It does not stop you from changing the contents of the array.', { hints: [] }),
        choice('f3', 'checkpoint', 'Conditions', 'What is (5 > 3) && (2 > 4)?', ['true', 'false'], 1, 'The right side is false, so && gives false.', { hints: [] }),
        choice('f4', 'checkpoint', 'Loop', 'What does this show?\n\nlet n = 0;\nfor (let i = 1; i <= 3; i++) n += i;\nconsole.log(n);', ['3', '6', '4'], 1, '1 + 2 + 3 = 6.', { hints: [] }),
        choice('f5', 'checkpoint', 'Scope', 'Where can a let variable declared inside an if block be used?', ['Anywhere in the file', 'Only inside that block', 'Only outside the block'], 1, 'let and const are block scoped.', { hints: [] }),
        codeTask('f6', 'checkpoint', 'Vowels', {
          prompt: 'Write a function countVowels(text) that returns how many of the letters a, e, i, o, u appear in text. Ignore case.', starter: 'function countVowels(text) {\n  // your code here\n}\n',
          tests: [T('countVowels("Lagos")', 2), T('countVowels("rhythm")', 0), T('countVowels("AEIOU")', 5)], hidden: [H('countVowels("Education")', 5), H('countVowels("")', 0), H('countVowels("bcd")', 0)], mustDefine: ['countVowels'],
          solution: 'function countVowels(text) {\n  let count = 0;\n  for (const ch of text.toLowerCase()) {\n    if ("aeiou".includes(ch)) count = count + 1;\n  }\n  return count;\n}', hints: [], explain: 'Lowercase the text, then count the letters found in "aeiou".',
        }),
        codeTask('f7', 'checkpoint', 'Reverse', {
          prompt: 'Write a function reverseWords(text) that returns the words of a sentence in reverse order. reverseWords("one two three") is "three two one".', starter: 'function reverseWords(text) {\n  // your code here\n}\n',
          tests: [T('reverseWords("one two three")', 'three two one'), T('reverseWords("hello")', 'hello')], hidden: [H('reverseWords("a b c d")', 'd c b a'), H('reverseWords("Ada Tobi")', 'Tobi Ada')], mustDefine: ['reverseWords'],
          solution: 'function reverseWords(text) { return text.split(" ").reverse().join(" "); }', hints: [], explain: 'split, reverse the array, then join.',
        }),
        codeTask('f8', 'checkpoint', 'Group totals', {
          prompt: 'Write a function totalByClass(pupils, className) that returns the total of the scores of the pupils whose class equals className.', starter: 'function totalByClass(pupils, className) {\n  // your code here\n}\n',
          tests: [T('totalByClass([{ class: "A", score: 10 }, { class: "B", score: 20 }, { class: "A", score: 5 }], "A")', 15)], hidden: [H('totalByClass([], "A")', 0), H('totalByClass([{ class: "C", score: 7 }], "A")', 0), H('totalByClass([{ class: "B", score: 30 }, { class: "B", score: 12 }], "B")', 42)], mustDefine: ['totalByClass'],
          solution: 'function totalByClass(pupils, className) {\n  return pupils.filter((p) => p.class === className).reduce((s, p) => s + p.score, 0);\n}', hints: [], explain: 'filter by class, then reduce to a total.',
        }),
      ], 1, { exam: true, threshold: 0.75 }),
      lesson('l3', 'Capstone: a pupil results report', 'By the end of this lesson, you have built and submitted a working results report program.', 60, [
        teach('t1', 'introduction', 'The project', [
          'You will build a small program that turns a list of pupils and their scores into a clear text report. You use almost everything from this course: objects, arrays, functions, loops, conditions and string methods.',
          'Plan on paper first: the data goes in, small functions each do one job, and a final function joins them. Build and test one function at a time.',
        ], { label: 'What the finished report looks like', text: 'Ada: 82 (A)\nTobi: 45 (F)\nZainab: 67 (B)\nClass average: 64.7\nTop pupil: Ada' }, { visual: VIS.jsCapstone }),
        teach('t2', 'explanation', 'The grading rule', [
          'Grades: 70 or more is A. 60 to 69 is B. 50 to 59 is C. Below 50 is F. The average is rounded to one decimal place. Use toFixed(1), which gives text, for the average line.',
        ], { label: 'Hint', text: 'const avg = 64.66666;\navg.toFixed(1); // "64.7"' }),
        codeTask('c1', 'guided', 'Step 1: grade', {
          prompt: 'Write grade(score) that returns "A" for 70 or more, "B" for 60 to 69, "C" for 50 to 59 and "F" below 50.', starter: 'function grade(score) {\n  // your code here\n}\n',
          tests: [T('grade(82)', 'A'), T('grade(67)', 'B'), T('grade(50)', 'C'), T('grade(45)', 'F')], hidden: [H('grade(70)', 'A'), H('grade(69)', 'B'), H('grade(60)', 'B'), H('grade(59)', 'C'), H('grade(49)', 'F'), H('grade(100)', 'A')], mustDefine: ['grade'],
          solution: 'function grade(score) {\n  if (score >= 70) return "A";\n  if (score >= 60) return "B";\n  if (score >= 50) return "C";\n  return "F";\n}', hints: ['Test from the highest grade down.'], explain: 'Test the highest boundary first.',
        }),
        codeTask('c2', 'guided', 'Step 2: class average', {
          prompt: 'Write classAverage(pupils) that returns the average score of an array of { name, score } objects. For an empty array return 0.', starter: 'function classAverage(pupils) {\n  // your code here\n}\n',
          tests: [T('classAverage([{ name: "A", score: 80 }, { name: "B", score: 60 }])', 70), T('classAverage([])', 0)], hidden: [H('classAverage([{ name: "A", score: 50 }])', 50), H('classAverage([{ name: "A", score: 1 }, { name: "B", score: 2 }])', 1.5)], mustDefine: ['classAverage'],
          solution: 'function classAverage(pupils) {\n  if (pupils.length === 0) return 0;\n  const sum = pupils.reduce((s, p) => s + p.score, 0);\n  return sum / pupils.length;\n}', hints: ['Reuse what you learned in map, filter and reduce.'], explain: 'reduce for the total, divide by the count.',
        }),
        codeTask('c3', 'guided', 'Step 3: top pupil', {
          prompt: 'Write topPupil(pupils) that returns the name of the pupil with the highest score. For an empty array return "none".', starter: 'function topPupil(pupils) {\n  // your code here\n}\n',
          tests: [T('topPupil([{ name: "Ada", score: 82 }, { name: "Tobi", score: 45 }])', 'Ada'), T('topPupil([])', 'none')], hidden: [H('topPupil([{ name: "A", score: 1 }, { name: "B", score: 9 }])', 'B')], mustDefine: ['topPupil'],
          solution: 'function topPupil(pupils) {\n  if (pupils.length === 0) return "none";\n  let best = pupils[0];\n  for (const p of pupils) if (p.score > best.score) best = p;\n  return best.name;\n}', hints: ['Check for the empty array first.'], explain: 'Remember the best pupil seen so far.',
        }),
        assignment('cap', 'independent', 'Submit your report program', {
          format: 'code', review: 'both', certRequired: true, maxAttempts: 5,
          prompt: 'Write report(pupils) that returns the full report as one string, one line per pupil in the form "Name: score (grade)", then "Class average: x" with one decimal place, then "Top pupil: name". Lines are joined with a newline (\\n). You may write helper functions grade, classAverage and topPupil again in this answer. Your code is tested here, then a reviewer reads it.',
          starter: 'function grade(score) {\n  // copy your solution from step 1\n}\n\nfunction classAverage(pupils) {\n  // copy your solution from step 2\n}\n\nfunction topPupil(pupils) {\n  // copy your solution from step 3\n}\n\nfunction report(pupils) {\n  // build and return the report text\n}\n',
          tests: [T('report([{ name: "Ada", score: 82 }, { name: "Tobi", score: 45 }, { name: "Zainab", score: 67 }])', 'Ada: 82 (A)\nTobi: 45 (F)\nZainab: 67 (B)\nClass average: 64.7\nTop pupil: Ada')],
          hidden: [H('report([{ name: "Kemi", score: 50 }])', 'Kemi: 50 (C)\nClass average: 50.0\nTop pupil: Kemi'), H('report([{ name: "A", score: 100 }, { name: "B", score: 59 }])', 'A: 100 (A)\nB: 59 (C)\nClass average: 79.5\nTop pupil: A'), H('report([{ name: "X", score: 30 }, { name: "Y", score: 60 }])', 'X: 30 (F)\nY: 60 (B)\nClass average: 45.0\nTop pupil: Y')],
          mustDefine: ['report', 'grade'],
          rubric: [{ id: 'clear', label: 'Code is readable: sensible names and small functions.' }, { id: 'reuse', label: 'report uses the helper functions rather than repeating their logic.' }, { id: 'edge', label: 'Handles the data without hard-coding the example pupils.' }],
          reviewGuide: 'Read the code. Check names, structure and reuse of helpers, and that nothing is hard-coded to the example data. Approve if the program is clear and general. Ask for changes if it only works for the examples or is copied without understanding.',
          solution: 'function grade(score) {\n  if (score >= 70) return "A";\n  if (score >= 60) return "B";\n  if (score >= 50) return "C";\n  return "F";\n}\nfunction classAverage(pupils) {\n  if (pupils.length === 0) return 0;\n  return pupils.reduce((s, p) => s + p.score, 0) / pupils.length;\n}\nfunction topPupil(pupils) {\n  if (pupils.length === 0) return "none";\n  let best = pupils[0];\n  for (const p of pupils) if (p.score > best.score) best = p;\n  return best.name;\n}\nfunction report(pupils) {\n  const lines = pupils.map((p) => `${p.name}: ${p.score} (${grade(p.score)})`);\n  lines.push("Class average: " + classAverage(pupils).toFixed(1));\n  lines.push("Top pupil: " + topPupil(pupils));\n  return lines.join("\\n");\n}',
          explain: 'Map each pupil to a line, add the summary lines, and join them with newlines.',
        }),
        say('c4', 'What you learned', 'Write a short note about the hardest part of the project and how you solved it. You can type it or dictate it.', ['Name one problem and one thing you did to fix it.'],
          [{ id: 'problem', label: 'Names a specific problem or difficulty.' }, { id: 'solution', label: 'Describes what the learner did to solve it.' }],
          'The hardest part was the average line. It showed 64.66666 at first. I found toFixed(1) and tested it with one pupil to make sure it gave 50.0.', 'Name the problem, then the fix.', 12),
      ], 1),
    ]),
  ],
};
