// learna/courses-js.js
import { teach, activity as act, lesson, section } from './courses-core.js';

const code = (o) => ({ type: 'code', language: 'javascript', ...o });

export const javascript = {
  id: 'javascript-foundations',
  title: 'JavaScript Foundations',
  shortDescription: 'Write small, working JavaScript programs and check them with real tests.',
  fullDescription: 'Learn the core of JavaScript by writing code, not just reading it. Each coding task runs in the Cognita code sandbox in your browser against tests you can read. You learn values, functions, conditions, arrays and loops.',
  category: 'coding', level: 'Beginner', estimatedDuration: '2 hours', estimatedMinutes: 120,
  whoFor: 'People who have never programmed, or who know a little and want solid basics.',
  prerequisites: ['A computer or phone with a modern browser', 'No programming experience needed'],
  learningOutcomes: ['Store and change values with variables', 'Write functions that return results', 'Make decisions with if statements', 'Process lists with arrays and loops'],
  skills: ['Variables', 'Functions', 'Conditions', 'Arrays', 'Loops', 'Reading test results'],
  practical: 'Six coding tasks. Each one has requirements, starter code and tests that run in the sandbox.',
  assessment: 'Code tasks pass when all their tests pass in the sandbox. Questions are checked exactly. A lesson is complete when you pass at least 70% of its activities without being shown the answer.',
  modes: ['coding', 'reading', 'testing'],
  access: 'plus', status: 'available', featured: true, version: '1.0.0', masteryThreshold: 0.7,
  references: [{ label: 'MDN Web Docs: JavaScript', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript' }],
  sections: [
    section('s1', 'Values and functions', 'Store information, then wrap logic in functions.', [
      lesson('l1', 'Variables and values', 'By the end of this lesson, you can declare a variable with const or let and use it in a calculation.', 20, [
        teach('t1', 'explanation', 'A variable is a named box', [
          'A variable stores a value so you can use it later. Use const for a value that will not be reassigned, and let for one that will change.',
          'JavaScript values include numbers (42), strings ("Ada") and booleans (true, false). You can combine numbers with + - * /.',
        ], { label: 'Example', text: 'const price = 1500;\nlet quantity = 2;\nquantity = quantity + 1;\nconst total = price * quantity; // 4500' }),
        act('a1', 'guided', 'Predict the value', {
          type: 'choice', prompt: 'What is the value of total?\n\nconst a = 4;\nlet b = 3;\nb = b + 2;\nconst total = a * b;',
          options: [{ id: 'a', text: '12' }, { id: 'b', text: '20' }, { id: 'c', text: '14' }],
          answer: 'b', why: { a: 'b changed to 5 before the multiplication.', c: 'The operator is *, not +.' },
          hints: ['Work out b first. It changes on line 3.'], explain: 'b becomes 5, so total is 4 * 5 = 20.',
        }),
        act('a2', 'guided', 'Const or let?', {
          type: 'choice', prompt: 'You are counting clicks. The number goes up each time. Which keyword should declare it?',
          options: [{ id: 'a', text: 'const' }, { id: 'b', text: 'let' }],
          answer: 'b', why: { a: 'A const variable cannot be reassigned, so count = count + 1 would fail.' },
          hints: ['Does the value change?'], explain: 'Use let when the value is reassigned.',
        }),
        act('a3', 'attempt', 'Write the calculation', code({
          prompt: 'Write a function totalPrice(price, quantity) that returns price multiplied by quantity.',
          starter: 'function totalPrice(price, quantity) {\n  // your code here\n}\n',
          tests: [{ name: 'totalPrice(1500, 2)', expr: 'totalPrice(1500, 2)', expect: 3000 }, { name: 'totalPrice(250, 0)', expr: 'totalPrice(250, 0)', expect: 0 }, { name: 'totalPrice(99, 3)', expr: 'totalPrice(99, 3)', expect: 297 }],
          solution: 'function totalPrice(price, quantity) { return price * quantity; }',
          hints: ['A function sends a value back with return.', 'return price * quantity;'], explain: 'return price * quantity;',
        })),
        act('a4', 'checkpoint', 'Which line fails?', {
          type: 'choice', prompt: 'Which code causes an error?',
          options: [{ id: 'a', text: 'let n = 1; n = 2;' }, { id: 'b', text: 'const n = 1; n = 2;' }, { id: 'c', text: 'const n = 1; const m = n + 1;' }],
          answer: 'b', why: { a: 'let allows reassignment.', c: 'This only reads n.' },
          hints: ['One line assigns to a const.'], explain: 'A const cannot be reassigned.',
        }),
      ]),
      lesson('l2', 'Functions', 'By the end of this lesson, you can write a function with parameters that returns a result.', 25, [
        teach('t1', 'explanation', 'Functions take inputs and return outputs', [
          'A function groups steps under a name. Parameters are the inputs. return sends the result back to the caller.',
          'A function that does not return anything gives back undefined.',
        ], { label: 'Example', text: 'function double(n) {\n  return n * 2;\n}\ndouble(4); // 8' }),
        act('b1', 'guided', 'What does it return?', {
          type: 'choice', prompt: 'What does this return?\n\nfunction f(x) {\n  x * 2;\n}\nf(5);',
          options: [{ id: 'a', text: '10' }, { id: 'b', text: 'undefined' }, { id: 'c', text: '5' }],
          answer: 'b', why: { a: 'The result is calculated but never returned.' },
          hints: ['Look for the word return.'], explain: 'There is no return statement, so the result is undefined.',
        }),
        act('b2', 'attempt', 'Greeting function', code({
          prompt: 'Write greet(name) that returns the text "Hello, " followed by the name and an exclamation mark. For "Ada" it returns "Hello, Ada!".',
          starter: 'function greet(name) {\n  // your code here\n}\n',
          tests: [{ name: 'greet("Ada")', expr: 'greet("Ada")', expect: 'Hello, Ada!' }, { name: 'greet("Tunde")', expr: 'greet("Tunde")', expect: 'Hello, Tunde!' }],
          solution: 'function greet(name) { return "Hello, " + name + "!"; }',
          hints: ['Join strings with +.', 'return "Hello, " + name + "!";'], explain: 'Join the pieces and return them.',
        })),
        act('b3', 'independent', 'Average of two numbers', code({
          prompt: 'Write average(a, b) that returns the average of two numbers.',
          starter: 'function average(a, b) {\n  // your code here\n}\n',
          tests: [{ name: 'average(2, 4)', expr: 'average(2, 4)', expect: 3 }, { name: 'average(10, 20)', expr: 'average(10, 20)', expect: 15 }, { name: 'average(-2, 2)', expr: 'average(-2, 2)', expect: 0 }],
          solution: 'function average(a, b) { return (a + b) / 2; }',
          hints: ['Add first, then divide. Use brackets.', 'return (a + b) / 2;'], explain: 'Add, then divide by 2.',
        })),
        act('b4', 'checkpoint', 'Name the parts', {
          type: 'match', prompt: 'Match each term to what it does.',
          pairs: [{ left: 'parameter', right: 'an input name in the function definition' }, { left: 'return', right: 'sends a result back' }, { left: 'call', right: 'runs the function with real values' }],
          hints: ['A call is when you write double(4).'], explain: 'Parameters receive values, return sends back a result, and a call runs the function.',
        }),
      ]),
    ]),
    section('s2', 'Decisions and lists', 'Choose between paths and work through collections.', [
      lesson('l1', 'Conditions', 'By the end of this lesson, you can use if and else to return different results.', 25, [
        teach('t1', 'explanation', 'if, else and comparisons', [
          'An if statement runs code only when a condition is true. Compare values with === (equal), !== (not equal), >, <, >= and <=.',
          'Use else for the other case. Use === rather than == so that JavaScript does not convert types silently.',
        ], { label: 'Example', text: 'function sign(n) {\n  if (n > 0) return "positive";\n  if (n < 0) return "negative";\n  return "zero";\n}' }),
        act('c1', 'guided', 'True or false?', {
          type: 'choice', prompt: 'What is the value of 5 >= 5?',
          options: [{ id: 'a', text: 'true' }, { id: 'b', text: 'false' }],
          answer: 'a', why: { b: '>= means greater than OR equal to.' }, hints: ['The two numbers are equal.'], explain: '5 is equal to 5, so >= is true.',
        }),
        act('c2', 'attempt', 'Pass or fail', code({
          prompt: 'Write result(score) that returns "pass" when score is 50 or more, and "fail" otherwise.',
          starter: 'function result(score) {\n  // your code here\n}\n',
          tests: [{ name: 'result(50)', expr: 'result(50)', expect: 'pass' }, { name: 'result(49)', expr: 'result(49)', expect: 'fail' }, { name: 'result(100)', expr: 'result(100)', expect: 'pass' }, { name: 'result(0)', expr: 'result(0)', expect: 'fail' }],
          solution: 'function result(score) { if (score >= 50) return "pass"; return "fail"; }',
          hints: ['Test 50 carefully. Is it a pass?', 'if (score >= 50) return "pass";'], explain: 'Use >= so that 50 passes.',
        })),
        act('c3', 'independent', 'Leap year', code({
          prompt: 'Write isLeapYear(year). A year is a leap year if it is divisible by 4, except years divisible by 100, unless the year is also divisible by 400. Return true or false.',
          starter: 'function isLeapYear(year) {\n  // your code here\n}\n',
          tests: [{ name: 'isLeapYear(2024)', expr: 'isLeapYear(2024)', expect: true }, { name: 'isLeapYear(2023)', expr: 'isLeapYear(2023)', expect: false }, { name: 'isLeapYear(1900)', expr: 'isLeapYear(1900)', expect: false }, { name: 'isLeapYear(2000)', expr: 'isLeapYear(2000)', expect: true }],
          solution: 'function isLeapYear(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }',
          hints: ['% gives the remainder. 2024 % 4 is 0.', 'Combine the rules with && and ||.'], explain: '(year % 4 === 0 && year % 100 !== 0) || year % 400 === 0',
        })),
        act('c4', 'checkpoint', 'Which operator?', {
          type: 'choice', prompt: 'Which operator checks that two values are equal without converting types?',
          options: [{ id: 'a', text: '=' }, { id: 'b', text: '==' }, { id: 'c', text: '===' }],
          answer: 'c', why: { a: 'A single = assigns a value.', b: '== converts types before comparing.' }, hints: ['It has three characters.'], explain: '=== is strict equality.',
        }),
      ]),
      lesson('l2', 'Arrays and loops', 'By the end of this lesson, you can loop over an array to add up or filter its values.', 30, [
        teach('t1', 'explanation', 'Arrays hold lists', [
          'An array stores several values in order: const marks = [60, 45, 82]. Read an item with its index, which starts at 0: marks[0] is 60. marks.length is the number of items.',
          'A for...of loop visits each item once.',
        ], { label: 'Example', text: 'let sum = 0;\nfor (const m of [60, 45, 82]) {\n  sum = sum + m;\n}\n// sum is 187' }),
        act('d1', 'guided', 'Read an item', {
          type: 'choice', prompt: 'const a = ["x", "y", "z"]; What is a[1]?',
          options: [{ id: 'a', text: '"x"' }, { id: 'b', text: '"y"' }, { id: 'c', text: '"z"' }],
          answer: 'b', why: { a: 'Index 0 is the first item.' }, hints: ['Counting starts at 0.'], explain: 'Index 1 is the second item.',
        }),
        act('d2', 'attempt', 'Sum an array', code({
          prompt: 'Write sum(numbers) that returns the total of all numbers in the array. An empty array returns 0.',
          starter: 'function sum(numbers) {\n  // your code here\n}\n',
          tests: [{ name: 'sum([1, 2, 3])', expr: 'sum([1, 2, 3])', expect: 6 }, { name: 'sum([])', expr: 'sum([])', expect: 0 }, { name: 'sum([10, -4])', expr: 'sum([10, -4])', expect: 6 }],
          solution: 'function sum(numbers) { let t = 0; for (const n of numbers) t += n; return t; }',
          hints: ['Start a total at 0 and add each item.', 'let total = 0; for (const n of numbers) { total = total + n; }'], explain: 'Keep a running total inside the loop.',
        })),
        act('d3', 'independent', 'Keep the passing marks', code({
          prompt: 'Write passing(marks) that returns a new array with only the marks that are 50 or more, in the same order.',
          starter: 'function passing(marks) {\n  // your code here\n}\n',
          tests: [{ name: 'passing([60, 45, 82])', expr: 'passing([60, 45, 82])', expect: [60, 82] }, { name: 'passing([10, 20])', expr: 'passing([10, 20])', expect: [] }, { name: 'passing([50])', expr: 'passing([50])', expect: [50] }],
          solution: 'function passing(marks) { const out = []; for (const m of marks) { if (m >= 50) out.push(m); } return out; }',
          hints: ['Start with an empty array and push the marks you keep.', 'out.push(m) adds an item.'], explain: 'Loop, test each mark with if, push the ones that pass.',
        })),
        act('d4', 'checkpoint', 'Array length', {
          type: 'choice', prompt: 'What is [4, 8, 15].length?',
          options: [{ id: 'a', text: '2' }, { id: 'b', text: '3' }, { id: 'c', text: '15' }],
          answer: 'b', why: { a: 'The last index is 2, but the length counts items.' }, hints: ['Count the items.'], explain: 'There are three items.',
        }),
      ]),
    ]),
  ],
};
