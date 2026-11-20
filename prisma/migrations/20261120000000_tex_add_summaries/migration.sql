-- tex: per-bookmark summaries (additive; no data changes)
ALTER TABLE "Bookmark" ADD COLUMN "summary" TEXT;
ALTER TABLE "Bookmark" ADD COLUMN "oneLine" TEXT;
ALTER TABLE "Bookmark" ADD COLUMN "keyPoints" TEXT;
ALTER TABLE "Bookmark" ADD COLUMN "action" TEXT;
ALTER TABLE "Bookmark" ADD COLUMN "summaryStatus" TEXT;
ALTER TABLE "Bookmark" ADD COLUMN "summaryError" TEXT;
ALTER TABLE "Bookmark" ADD COLUMN "summarizedAt" DATETIME;

-- CreateIndex
CREATE INDEX "Bookmark_action_idx" ON "Bookmark"("action");

-- CreateIndex
CREATE INDEX "Bookmark_summaryStatus_idx" ON "Bookmark"("summaryStatus");
