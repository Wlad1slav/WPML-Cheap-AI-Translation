export type CliOptions = {
  postsDir: string;
  outDir: string;
  file: string | null;
  targetLanguage: string | null;
  priceInputPer1M: number | null;
  priceCachedInputPer1M: number | null;
  priceOutputPer1M: number | null;
  model: string;
  concurrency: number;
  preservePageArticleHandle: boolean;
  overwrite: boolean;
};