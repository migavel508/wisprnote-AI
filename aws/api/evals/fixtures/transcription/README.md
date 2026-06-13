# Transcription eval fixtures

Drop **matched pairs** here to measure Deepgram (nova-3) accuracy:

```
meeting1.wav   # audio clip  (wav | mp3 | m4a | flac | ogg)
meeting1.txt   # exact ground-truth transcript of that clip
```

Guidelines:
- Keep clips short (10–60s) and **sanitised** — no confidential meeting content.
- The ground-truth `.txt` should be a faithful human transcript (the reference).
- `transcription.eval.ts` auto-discovers every `<name>.<audio>` + `<name>.txt` pair.

Run (from `aws/api`):

```
DEEPGRAM_API_KEY=...  BRAINTRUST_API_KEY=sk-...  \
  npx braintrust eval evals/transcription.eval.ts
```

Score: `word_accuracy` = 1 − WER (Word Error Rate). 1.0 = perfect transcription.

> Audio files are intentionally not committed. Add your own; consider git-ignoring
> large media if you don't want them in the repo.
