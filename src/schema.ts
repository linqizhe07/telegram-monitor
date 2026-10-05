import { z } from 'zod';

// Everything the model returns is checked against these schemas (structured outputs on the
// API side, zod on ours). Every field is required; "nothing" is an empty string or array.

const ref = z.number().int().describe('A message id from the transcript: the number after # in "[#5012 10:41 U3]".');

const itemFields = {
  title: z.string().describe('Headline, at most ~12 words (~24 汉字).'),
  detail: z.string().describe('One or two specific sentences: what was said, by whom (aliases), numbers, what is at stake.'),
  people: z.array(z.string()).describe('Aliases (U1, U2…) of the people mainly involved.'),
  refs: z.array(ref).describe('1–6 message ids that support this item.'),
  evidence: z
    .array(z.string())
    .describe('1–2 short quotes (at most ~80 characters each) copied character for character from the cited messages.'),
  continues: z
    .string()
    .describe('Code of the item in <recent_history> that this continues (e.g. "P3"), or "" when it is new.'),
};

export const TopicSchema = z.object(itemFields);
export const PainPointSchema = z.object({
  ...itemFields,
  severity: z.enum(['low', 'medium', 'high']).describe('How much it hurts the people raising it.'),
});
export const IdeaSchema = z.object(itemFields);
export const OpportunitySchema = z.object({
  ...itemFields,
  why_now: z.string().describe('Why this opening exists now, from the chat.'),
  next_step: z.string().describe('One concrete next step someone in the group could take.'),
});
export const QuestionSchema = z.object(itemFields);

export const DigestSchema = z.object({
  headline: z.string().describe('One sentence: the most important thing that happened in the window.'),
  topics: z.array(TopicSchema),
  pain_points: z.array(PainPointSchema),
  ideas: z.array(IdeaSchema),
  opportunities: z.array(OpportunitySchema),
  open_questions: z.array(QuestionSchema),
  quiet: z.boolean().describe('true when the window had too little substantive discussion to digest.'),
});

export type Digest = z.infer<typeof DigestSchema>;
export type DigestItem = z.infer<typeof TopicSchema>;
export type PainPoint = z.infer<typeof PainPointSchema>;
export type Opportunity = z.infer<typeof OpportunitySchema>;

export const SECTIONS = ['topics', 'pain_points', 'ideas', 'opportunities', 'open_questions'] as const;
export type Section = (typeof SECTIONS)[number];

export function allItems(d: Digest): { section: Section; item: DigestItem; index: number }[] {
  const out: { section: Section; item: DigestItem; index: number }[] = [];
  for (const section of SECTIONS) d[section].forEach((item, index) => out.push({ section, item, index }));
  return out;
}

export const emptyDigest = (): Digest => ({
  headline: '',
  topics: [],
  pain_points: [],
  ideas: [],
  opportunities: [],
  open_questions: [],
  quiet: true,
});

/** The editor's critique of a digest that was posted. Feeds the improver. */
export const CritiqueSchema = z.object({
  missed: z
    .array(z.object({ what: z.string(), refs: z.array(ref) }))
    .describe('Substantive discussions the digest left out or under-weighted, with the message ids that show them.'),
  misplaced: z.array(z.string()).describe('Items in the wrong section, and where they belong.'),
  vague: z.array(z.string()).describe('Items too generic to be useful, and what was missing.'),
  noise: z.array(z.string()).describe('Items that should not be in the digest at all.'),
  scores: z
    .object({ coverage: z.number(), accuracy: z.number(), insight: z.number(), concision: z.number() })
    .describe('Each from 1 (poor) to 5 (excellent).'),
  summary: z.string().describe('Two sentences: the single most important fix.'),
});
export type Critique = z.infer<typeof CritiqueSchema>;

/** Pairwise judgement between two digests of the same window. */
export const JudgeSchema = z.object({
  winner: z.enum(['A', 'B', 'tie']),
  confidence: z.enum(['low', 'medium', 'high']),
  reasons: z.string().describe('Two to four sentences on the decisive differences.'),
  a_weaknesses: z.array(z.string()),
  b_weaknesses: z.array(z.string()),
});
export type Judgement = z.infer<typeof JudgeSchema>;

export const OPERATORS = ['repair', 'specialize', 'simplify', 'crossover', 'explore'] as const;
export type Operator = (typeof OPERATORS)[number];

/** The improver's output: mutated playbooks plus its own rewritten strategy notes. */
export const ImproveSchema = z.object({
  improver_notes: z
    .string()
    .describe('Your rewritten strategy notes for future rounds (at most 1200 characters): what has worked for this group, what to try next.'),
  candidates: z.array(
    z.object({
      operator: z.enum(OPERATORS),
      rationale: z.string().describe('The weakness this addresses and why the change should help, in at most two sentences.'),
      playbook: z.string().describe('The complete new playbook text (at most 3000 characters).'),
    }),
  ),
});
export type Improvement = z.infer<typeof ImproveSchema>;

/** Reader feedback distilled into notes the judge uses as tie-breakers. */
export const CalibrateSchema = z.object({
  judge_notes: z.string().describe('3–8 short lines on what these readers value and dislike in a digest (at most 800 characters).'),
});
export type Calibration = z.infer<typeof CalibrateSchema>;
