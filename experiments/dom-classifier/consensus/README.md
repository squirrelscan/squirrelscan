# Private consensus import

`annotate_batch.py` is the only supported importer. It joins reviewer decisions
to blind packets by record type, split, page/node/capture identity, and the
SHA-256 of the serialized input. It never aligns rows by position or reads
teacher output.

Each decision declares `labelingMethod`. Only
`independent_reasoned_review` may produce an unvalidated Luna silver record;
`heuristic_rule` remains provisional and is excluded from evaluation. Component
type is categorical. Other axes may carry positive labels while `complete` is
false; those claims must never be converted into negative labels.

Use separate approved validation and test JSONL files and bind both hashes in
the private manifest. The resulting silver smoke set is not human gold and
does not support general-quality claims.
