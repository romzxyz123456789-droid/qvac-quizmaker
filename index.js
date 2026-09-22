#!/usr/bin/env node
// qvac-quizmaker: turn a local notes file into a quiz, entirely on-device.
import { readFileSync, existsSync } from 'node:fs';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadModel, completion, unloadModel, LLAMA_3_2_1B_INST_Q4_0 } from '@qvac/sdk';

const notesPath = process.argv[2];

if (!notesPath || !existsSync(notesPath)) {
  console.error('Usage: node index.js <path-to-notes.txt>');
  process.exit(1);
}

const notes = readFileSync(notesPath, 'utf-8').trim();

if (!notes) {
  console.error('Notes file is empty.');
  process.exit(1);
}

const rl = readline.createInterface({ input, output });

function progressBar(pct) {
  const width = 24;
  const filled = Math.round((width * pct) / 100);
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}] ${pct}%`;
}

async function askModel(modelId, prompt) {
  const { tokenStream } = completion({
    modelId,
    history: [{ role: 'user', content: prompt }],
    stream: true,
  });
  let text = '';
  for await (const token of tokenStream) {
    text += token;
  }
  return text.trim();
}

// Small on-device models are unreliable at producing strict JSON, so we ask
// for a plain-text block format instead and parse it with a simple regex.
function parseQuiz(text) {
  const blocks = text.split(/\n(?=Q:)/).filter((b) => b.trim().startsWith('Q:'));
  const quiz = [];
  for (const block of blocks) {
    const question = block.match(/Q:\s*(.+)/)?.[1]?.trim();
    const choices = ['A', 'B', 'C', 'D'].map(
      (letter) => block.match(new RegExp(`${letter}\\)\\s*(.+)`))?.[1]?.trim()
    );
    const answerLetter = block.match(/ANSWER:\s*([ABCD])/)?.[1];
    if (question && choices.every(Boolean) && answerLetter) {
      quiz.push({ question, choices, answerIndex: answerLetter.charCodeAt(0) - 65 });
    }
  }
  if (quiz.length === 0) throw new Error('Model did not return any parsable questions.');
  return quiz;
}

async function main() {
  console.log('Loading model on-device (first run downloads it once)...');
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    onProgress: ({ percentage }) => process.stdout.write(`\r${progressBar(percentage)}`),
  });
  process.stdout.write('\n');
  console.log('Model ready. Generating quiz from your notes...\n');

  const prompt = [
    'You write short quizzes for studying. Read the notes below and produce exactly 5',
    'multiple-choice questions covering the key facts. Use EXACTLY this plain-text format',
    'for each question, with no extra commentary before or after:',
    '',
    'Q: <question text>',
    'A) <choice>',
    'B) <choice>',
    'C) <choice>',
    'D) <choice>',
    'ANSWER: <A, B, C, or D>',
    '',
    'Notes:',
    '"""',
    notes,
    '"""',
  ].join('\n');

  let quiz;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = await askModel(modelId, prompt);
    try {
      quiz = parseQuiz(raw);
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      console.log('Model output did not parse, retrying...');
    }
  }

  let score = 0;
  for (const [i, q] of quiz.entries()) {
    console.log(`\nQ${i + 1}. ${q.question}`);
    q.choices.forEach((c, idx) => console.log(`  ${String.fromCharCode(65 + idx)}) ${c}`));
    const answer = (await rl.question('Your answer (A/B/C/D): ')).trim().toUpperCase();
    const givenIndex = answer.charCodeAt(0) - 65;
    if (givenIndex === q.answerIndex) {
      console.log('Correct!');
      score++;
    } else {
      console.log(`Nope. Correct answer: ${String.fromCharCode(65 + q.answerIndex)}) ${q.choices[q.answerIndex]}`);
    }
  }

  console.log(`\nScore: ${score}/${quiz.length}`);

  rl.close();
  await unloadModel({ modelId });
}

main().catch((err) => {
  console.error('Error:', err.message);
  rl.close();
  process.exit(1);
});
