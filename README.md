# WPML Cheap AI Translation

## Features

1. Reads a selected `.xliff` file from `posts`
2. Translates `source` content into `target-language` with openai `model`
3. Writes a separate import-ready XLIFF file for WPML into `wpml-import`

## Setup

```bash
npm install
```

Set API key:

```
OPENAI_API_KEY="your_api_key"
```

## Run

```bash
npm run translate:wpml -- --file "Western Bid-translation-job-264.xliff"
```

If your npm treats `--file` as npm config, use positional file argument:

```bash
npm run translate:wpml -- "Western Bid-translation-job-264.xliff"
```

Choose translation language:

```bash
npm run translate:wpml -- "Western Bid-translation-job-264.xliff" "de"
```

or

```bash
npm run translate:wpml -- --file "Western Bid-translation-job-264.xliff" --target-language de
```

Optional flags:

- `--posts-dir posts`
- `--out-dir wpml-import`
- `--target-language de` (alias: `--to de`)
- `--model gpt-4.1-nano`
- `--concurrency 3`
- `--overwrite`

Output file name format:

`<original-name>.<target-language>.wpml-import.xliff`
