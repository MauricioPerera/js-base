'use strict';

async function turnImpl(deps, { sessionId, userText, now }) {
  const { assembler, ingestor, promoter, llm } = deps;

  // 1. Get next sequence number (derived from persisted state)
  const seq = await ingestor.nextSeq(sessionId);

  // 2. Assemble context (bubbles on error without calling llm)
  const assembly = await assembler.assemble({ sessionId, turnText: userText, now });

  // 3. Call LLM (wraps error with code 'LLM' on failure)
  let reply;
  try {
    reply = await llm({ context: assembly.context });
  } catch (err) {
    const e = new Error(err.message);
    e.code = 'LLM';
    e.cause = err;
    throw e;
  }

  // 4. Ingest turn (bubbles with reply attached on error)
  try {
    await ingestor.ingestTurn({ sessionId, seq, userText, assistantText: reply, assembly, now });
  } catch (err) {
    err.reply = reply;
    throw err;
  }

  // 5. Compact if needed
  const compaction = await promoter.maybeCompact({ sessionId, now });

  return { reply, seq, assembly, compaction };
}

function makeLoop({ assembler, ingestor, promoter, llm, config }) {
  return {
    turn: (args) => turnImpl({ assembler, ingestor, promoter, llm }, args),
  };
}

module.exports = { makeLoop };
