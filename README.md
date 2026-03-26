# WPML Cheap AI Translation

## Features

1. Reads a selected `.xliff` file from `posts`
2. Translates `source` content into `target-language` with openai `model`
3. Writes a separate import-ready XLIFF file for WPML into `wpml-import`
4. Shows token usage and estimated translation cost in USD

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

If npm swallows `--model`, you can pass model as positional 2nd argument (must start with `gpt-`):

```bash
npm run translate:wpml -- "Western Bid-translation-job-264.xliff" "gpt-5-nano"
```

Optional flags:

- `--posts-dir posts`
- `--out-dir wpml-import`
- `--target-language de` (alias: `--to de`)
- `--model gpt-4.1-nano`
- `--concurrency 3`
- `--price-input 0.10` (USD per 1M input tokens)
- `--price-cached 0.025` (USD per 1M cached input tokens)
- `--price-output 0.40` (USD per 1M output tokens)
- `--overwrite`

Output file name format:

`<original-name>.<target-language>.wpml-import.xliff`

## Token and Cost Stats

After translation, the script prints:

- input, cached input, output, and total tokens
- estimated cost in USD per translated file

Default rates for known models are based on:

`https://platform.openai.com/pricing` (checked 2026-03-26)
