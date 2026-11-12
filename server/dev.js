// Local development server (never used in production). Plain-HTTP cookies, a throwaway database and a
// fixed dev-only password from DEV_PASSWORD (default below). Fetches real tweets from FxTwitter.
//   node dev.js            -> http://localhost:8099
import { createApp } from './src/server.js';
import { makePasswordHash } from './src/auth.js';

const port = Number(process.env.PORT || 8099);
const password = process.env.DEV_PASSWORD || 'dev-only-password';
const app = createApp({
  dbPath: process.env.VAULT_DB || './dev-vault.db',
  passwordHash: await makePasswordHash(password, 100000),
  secret: 'dev-only-secret-dev-only-secret-dev-only',
  origins: `http://localhost:${port},http://127.0.0.1:${port}`,
  cookieSecure: false,
  trustProxy: false,
  cacheStatic: false,
  realWeb: true,   // read shared web pages for real, like the production server
  // Without ANTHROPIC_API_KEY, dev uses a labelled stand-in so the translation UI can be tried for free.
  anthropicClient: process.env.ANTHROPIC_API_KEY ? undefined : {
    messages: {
      async create({ messages }) {
        const src = String(messages[0].content).replace(/^<source>\n|\n<\/source>$/g, '');
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: `[dev stand-in translation] ${src.length} characters of text would be translated to English here.\n\n${src}` }] };
      },
    },
  },
  // Voice notes without keys: a labelled stand-in transcript (from the recording's length) and stand-in
  // notes, so recording, upload and the note page can be tried for free. Real keys use the real services.
  ...(process.env.GROQ_API_KEY ? {} : {
    groqKey: 'dev-stand-in',
    groqFetchFn: async () => {
      const segments = Array.from({ length: 6 }, (_, i) => ({ start: i * 40, end: i * 40 + 30, no_speech_prob: 0.01, avg_logprob: -0.2,
        text: `[dev stand-in transcript] Part ${i + 1}: this is where Whisper's words would go. We should write the plan by Friday.` }));
      return new Response(JSON.stringify({ text: '', language: 'english', duration: 240, segments }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  }),
  ...(process.env.ANTHROPIC_API_KEY ? {} : {
    voiceClient: { beta: { messages: { stream(params) {
      const isNotes = !!params.output_config;
      const text = isNotes ? JSON.stringify({
        title: 'Dev stand-in: planning the voice feature', one_line: 'A stand-in notes pack made without calling Claude.',
        summary: 'In production Claude Sonnet writes this from the transcript. Here it is fixed text, so the page can be tried for free.',
        detailed_notes: '## What was said\n\n- The **transcript** comes from Groq Whisper [00:00]\n- The notes come from Claude [00:40]\n\n## Next\n\nTry *Another pass* with your own prompt.',
        key_points: ['Record up to 90 minutes [00:00]', 'Notes are written automatically [01:20]'],
        action_items: [{ text: 'Write the plan [00:40]', owner: '', due: 'Friday', priority: 'high' }, { text: 'Try another pass', owner: '', due: '', priority: 'medium' }],
        decisions: ['Use 16 kbps Opus'], objectives: ['One step from voice to notes'], open_questions: ['Which prompts are worth presets?'], ideas: ['Send outlines to the content pipeline'], tags: ['dev', 'voice'],
      }) : `## Dev stand-in pass\n\nClaude would answer your prompt here, reading the whole transcript [01:20].\n\n1. First point\n2. Second point`;
      return { finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] }) };
    } } } },
  }),
});
await app.listen(port, '127.0.0.1');
console.log(`Tweet Vault dev server on http://localhost:${port}`);
