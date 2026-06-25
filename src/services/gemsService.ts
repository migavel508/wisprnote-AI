// Gems — reusable chat prompts ("recipes") the user can run against their
// meeting notes. Built-in Gems ship with the app; user Gems live in localStorage.
// Running a Gem just sends its `prompt` to the all-meetings chat.

export interface Gem {
  id: string;
  name: string;
  description: string;
  prompt: string;
  author?: string;       // e.g. "Matt Mochary" / "Granola"
  featured?: boolean;
  builtIn?: boolean;
  /** Routing hints for the chat engine (P4). 'extract' + 'full' = per-meeting
   *  read-each-meeting path; 'qa' + 'slice' = targeted RAG. */
  intent?: 'qa' | 'extract' | 'person';
  depth?: 'slice' | 'full';
}

// Prepended to a Gem's prompt when it's a per-meeting extraction task, so the
// agent deterministically reads each meeting in full before answering.
export const EXTRACT_DIRECTIVE =
  '[Routing: this is a per-meeting extraction task. First call search_notes with an empty query + the right recent_days to LIST the meetings in scope, then call read_meeting_notes for EACH meeting in scope (fan out the calls) and extract from its FULL notes. Never report a meeting as empty from a search snippet — only after reading it.]';

/** The final prompt to send for a Gem — prefixed with the extraction directive
 *  when the Gem is an extract/full Gem. */
export function gemPromptFor(gem: Gem): string {
  return gem.intent === 'extract'
    ? `${EXTRACT_DIRECTIVE}\n\n${gem.prompt}`
    : gem.prompt;
}

const COACH_ME_MATT_PROMPT = `<Matt Mochary Curriculum>
### 1. The Foundational Pillars: ACT and The Emotional Brain

The Mochary Method is a framework built on three foundational pillars: **Accountability**, **Coaching**, and **Transparency** (ACT). This methodology aims to create highly effective and efficient organizations by ensuring everyone is aligned, responsible, and continually improving.

* **Accountability** involves setting a clear destination (Vision, OKRs, KPIs), defining the specific actions to get there, and then verifying whether those actions were completed.
* **Coaching** focuses on the current state of the organization, department, or individual. It means describing what's working, what's not working, and proposing solutions to problems.
* **Transparency** is about fostering a culture where people can give and receive feedback openly and regularly. This feedback should be directed to a person's manager, peers, and reports.

A core teaching that underpins all of these principles is the idea that **fear and anger give bad advice**. When you experience these emotions, your brain's pre-frontal cortex, responsible for creative thought and problem-solving, is bypassed by the amygdala, or "reptile brain," which is wired for fight or flight. The solution is to intentionally "shift" out of these emotions before acting — for example, getting curious about someone's motivations instead of wanting to "crush" them.

### 2. Meetings, Feedback, Hiring, Energy, Tools, and Personal Development
The method also covers efficient meetings (Meeting Owner, async prep, time-boxing, DRIs, group 1-1s), a feedback culture (the 5 A's: Ask, Acknowledge, Appreciate, Accept, Act), hiring only A-players (anti-sell, speed, top-grading references), the Energy Audit (Zone of Genius), GTD / Inbox Zero, clean escalation, RAPID decisions, conscious leadership (100% responsibility, curiosity over being right), and the importance of specific praise.
</Matt Mochary Curriculum>

Before generating your output, first read all provided context, carefully consider my specific role and responsibilities, and adapt your coaching advice so it's directly relevant to my situation and role.

You are Matt Mochary. Focusing on the past week, give me brief and insightful advice from a coaching session telling me how I can improve professionally. Be very specific and concrete with your suggestions and examples.

Open with a sharp, short analytical introduction about how I'm doing right now, applying Matt Mochary's wisdom and coaching style.

Output no more than 5 points, combining insights and recommendations. Use markdown; ## for headings and write in prose beneath each.`;

const BUILT_IN_GEMS: Gem[] = [
  {
    id: 'coach-me-matt',
    name: 'Coach me Matt',
    description: 'Delivers leadership coaching advice based on the Mochary Method. Read the curriculum that inspired the recipe here: mocharymethod.com/learn',
    author: 'Matt Mochary',
    featured: true,
    builtIn: true,
    intent: 'extract',
    depth: 'full',
    prompt:COACH_ME_MATT_PROMPT,
  },
  {
    id: 'list-recent-todos',
    name: 'List recent todos',
    description: 'Extracts and displays your outstanding to-dos from recent meeting notes.',
    author: 'Wisprnote',
    builtIn: true,
    intent: 'extract',
    depth: 'full',
    prompt:`Scan my recent meetings in reverse chronological order, read the latest day plus earlier complete days until at least 5 meetings are covered, then extract likely personal to-dos only. Group the action items by meeting, with the meeting title as a heading. Use markdown.`,
  },
  {
    id: 'write-weekly-recap',
    name: 'Write weekly recap',
    description: 'Generates a weekly recap of accomplishments for your team.',
    author: 'Wisprnote',
    builtIn: true,
    intent: 'extract',
    depth: 'full',
    prompt:`I need to write a recap of my week to share with my team. The goal is for my team to understand what I worked on / accomplished. Recaps should always focus on a full calendar week. Figure out today's date — if it's the beginning of the week (Sunday–Wednesday) focus on the previous calendar week, if it's the end of the week (Thursday–Saturday), focus on the current week. Use markdown with clear headings.`,
  },
  {
    id: 'streamline-calendar',
    name: 'Streamline my calendar',
    description: 'Reviews your recent meetings and suggests which to cut, shorten, or make async.',
    author: 'Wisprnote',
    builtIn: true,
    intent: 'extract',
    depth: 'full',
    prompt:`Review my recent meetings and suggest how to streamline my calendar: which meetings could be shortened, made asynchronous, delegated, or cancelled. For each, give a one-line rationale. Use markdown.`,
  },
  {
    id: 'blind-spots',
    name: 'Blind spots',
    description: 'Surfaces themes, risks, and blind spots across your recent meetings.',
    author: 'Wisprnote',
    builtIn: true,
    intent: 'extract',
    depth: 'full',
    prompt:`Look across my recent meetings and surface my blind spots: recurring risks, unresolved decisions, commitments I may be forgetting, and themes I'm not paying enough attention to. Be direct and specific. Use markdown.`,
  },
];

const USER_GEMS_KEY = 'wn.gems.v1';

function readUserGems(): Gem[] {
  try {
    const raw = localStorage.getItem(USER_GEMS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeUserGems(gems: Gem[]): void {
  try { localStorage.setItem(USER_GEMS_KEY, JSON.stringify(gems)); } catch { /* quota — non-fatal */ }
}

export function getBuiltInGems(): Gem[] {
  return BUILT_IN_GEMS;
}

export function getUserGems(): Gem[] {
  return readUserGems();
}

export function getAllGems(): Gem[] {
  return [...readUserGems(), ...BUILT_IN_GEMS];
}

export function createGem(input: { name: string; description: string; prompt: string }): Gem {
  const gem: Gem = {
    id: `gem_${Math.random().toString(36).slice(2, 9)}`,
    name: input.name.trim(),
    description: input.description.trim(),
    prompt: input.prompt.trim(),
    author: 'You',
    builtIn: false,
  };
  writeUserGems([gem, ...readUserGems()]);
  return gem;
}

export function deleteGem(id: string): void {
  writeUserGems(readUserGems().filter((g) => g.id !== id));
}
