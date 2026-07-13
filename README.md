# WPML AI Translation

## Features

1. Reads a selected `.xliff` file from `posts`
2. Translates `source` content into `target-language` with openai `model`
3. Writes a separate import-ready XLIFF file for WPML into `wpml-import`
4. Shows token usage and estimated translation cost in USD
5. Appends translation time, token usage, and estimated cost to a persistent history log

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
- `--preserve-page-article-handle` (default, preserve original handle/slug for `post_page` and `post_post` when XLIFF exposes it; otherwise rely on WPML `Page URL = Copy from original language`)
- `--translate-page-article-handle` (disable handle/slug preservation for `post_page` and `post_post`)
- `--overwrite`

Output file name format:

`<original-name>.<target-language>.wpml-import.xliff`

## Translate All Files From `posts`

Translate every `.xliff` file from `posts`:

```bash
npm run translate:all -- --target-language de
```

If npm swallows `--model`, you can pass model as a positional argument:

```bash
npm run translate:all -- gpt-5-nano
```

Useful options:

- `--posts-dir posts`
- `--out-dir wpml-import`
- `--target-language de` (alias: `--to de`)
- `--model gpt-4.1-nano`
- `--concurrency 3`
- `--preserve-page-article-handle` (default, same caveat about WPML `Page URL`)
- `--translate-page-article-handle`
- `--overwrite`
- `--start-from "Western Bid-translation-job-264.xliff"` (resume from a specific file)
- `--limit 10` (translate only first N files after filtering)
- `--continue-on-error`

This command runs `translate:wpml` for each file sequentially and prints a batch summary.

## Handle Preservation Caveat

For page/article jobs, WPML can omit a dedicated slug field from exported XLIFF files. In that case this tool cannot physically write the original handle into the translated XLIFF on its own.

If your translated import must keep the original slug, set:

`WPML -> Settings -> Translated documents options -> Page URL -> Copy from original language`

If you want the slug to appear as a separate field in translation/XLIFF, set `Page URL` to `Translate` before exporting the job.

Official WPML docs:
https://wpml.org/documentation/getting-started-guide/translating-page-slugs/

## Archive Translations To ZIP

Archive translated files (from `wpml-import`) into ZIP:

```bash
npm run zip:translations
```

Useful options:

- `--source-dir wpml-import`
- `--out-dir archives`
- `--name de-translations.zip`
- `--overwrite`

By default the script creates ZIP in `archives` with a timestamped file name.

## Split Files Into Multiple ZIP Parts

Create several standalone ZIP archives instead of one large file.
Recommended on PowerShell/npm:

```bash
npm run zip:split -- 25MB wpml-import archives de-translations
```

Flag-based form also works:

```bash
npm run zip:split -- --max-size 25MB
```

Useful options:

- `--source-dir wpml-import`
- `--out-dir archives`
- `--name de-translations`
- `--max-size 25MB`
- `--overwrite`

The splitter groups files by their original sizes, then creates multiple ZIP parts such as:

`de-translations-part01-of03.zip`

This is useful when you need smaller upload-ready archives instead of one large ZIP.

## Split One Existing ZIP Into Two Parts

If WPML rejects one of the generated archives, split that specific ZIP into two
smaller standalone archives:

```bash
npm run zip:split-file -- archives/de-translations-part01-of03.zip
```

By default, the two new files are created next to the source archive:

`de-translations-part01-of03_1.zip`

`de-translations-part01-of03_2.zip`

The original ZIP is left unchanged. Files are balanced between the new archives
by their uncompressed sizes. Optional arguments:

- `--out-dir archives/smaller`
- `--name de-translations-retry`
- `--parts 3` (create more than two parts)
- `--overwrite`

## Token and Cost Stats

After translation, the script prints:

- time spent translating
- input, cached input, output, and total tokens
- estimated cost in USD per translated file

Default rates for known models are based on:

`https://platform.openai.com/pricing` (checked 2026-03-26)

Every successful translation is also appended as one JSON object per line to:

`logs/translation-history.jsonl`

The history file is append-only during normal execution, so subsequent translations do not overwrite earlier entries. Each entry includes the completion date, input and output paths, model, languages, duration, token usage, pricing rates, and estimated cost breakdown.
