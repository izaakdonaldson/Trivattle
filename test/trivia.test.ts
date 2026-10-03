import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateGrounding,
  validateBank,
  deterministicConflicts,
  generateTrivia,
} from '../src/trivia.js';
import { questionDraftSchema } from '../src/domain.js';
import { questions, source, cfg, MockText } from './helpers.js';
const draft = () => {
  const { text, options, correctIndex, explanation, evidence, factKey } = questions()[0]!;
  return { text, options, correctIndex, explanation, evidence, factKey };
};
test('grounding checks exact stored revision evidence and literal correct answer', () => {
  validateGrounding(draft(), source());
  assert.throws(() =>
    validateGrounding(
      { ...draft(), evidence: 'An invented fact that was never part of the source.' },
      source(),
    ),
  );
  assert.throws(() => validateGrounding({ ...draft(), correctIndex: 1 }, source()));
  assert.throws(() =>
    validateGrounding({ ...draft(), options: ['Copper', 'Copper', 'A', 'B'] }, source()),
  );
  const bank = questions();
  bank[0]!.revisionId = 999;
  assert.throws(() => validateBank(bank, source(), cfg()));
});
test('bank checks bounds, question identity, repeated facts and near duplicate stems', () => {
  validateBank(questions(), source(), cfg());
  assert.throws(() => validateBank(questions().slice(0, 9), source(), cfg()));
  assert.throws(() => validateBank([...questions(), ...questions().slice(0, 4)], source(), cfg()));
  const bank = questions();
  bank[1]!.factKey = bank[0]!.factKey;
  assert(deterministicConflicts(bank, cfg()).length > 0);
  assert.throws(() => validateBank(bank, source(), cfg()));
});
test('generation audits accuracy then the complete bank', async () => {
  const p = new MockText();
  const bank = await generateTrivia(source(), p, cfg(), [], () => {});
  assert.equal(bank.length, 12);
  assert(p.calls.some((c) => c.startsWith('Audit EACH')));
  assert(p.calls.some((c) => c.startsWith('Review the ENTIRE')));
});
test('unsupported answers never publish; bounded retries save progress', async () => {
  const p = new MockText();
  p.accuracyReject = true;
  let updates = 0;
  await assert.rejects(generateTrivia(source(), p, cfg(), [], () => updates++));
  assert.equal(updates, cfg().trivia.attempts);
});
test('cross-question leakage blocks publication and records conflicting IDs', async () => {
  const p = new MockText();
  p.leak = true;
  const seen: string[] = [];
  await assert.rejects(
    generateTrivia(source(), p, cfg(), [], (progress) =>
      seen.push(...progress.conflicts.map((c) => c.reason)),
    ),
  );
  assert(seen.includes('Indirect answer giveaway detected'));
});
test('10 trustworthy questions accepted after target retry budget, but 9 rejected', async () => {
  class Small extends MockText {
    override async json<T>(task: string, input: any, schema: any): Promise<T> {
      const result: any = await super.json(task, input, schema);
      if (task.startsWith('Generate article-specific'))
        result.questions = result.questions.slice(0, this.count);
      return result;
    }
    count = 10;
  }
  const p = new Small();
  assert.equal((await generateTrivia(source(), p, cfg(), [], () => {})).length, 10);
  p.count = 9;
  await assert.rejects(generateTrivia(source(), p, cfg(), [], () => {}));
});
