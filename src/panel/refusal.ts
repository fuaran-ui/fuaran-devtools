// ============================================================================
//  panel/refusal — what a refused edit tells the user to do next.
//
//  §8.4 is unusually direct about why the refusal classes are separate wire
//  values rather than one `refused` flag with prose: each implies a DIFFERENT
//  next action, and collapsing them "sends the user to fix a tree that was
//  never the problem". A panel that rendered every refusal as one red line
//  would be doing exactly the collapse the contract spent three wire values
//  avoiding.
//
//  So the mapping below is the contract's table, made visible. The guidance is
//  the panel's own words; the CLASS is the host's, and it is shown verbatim
//  beside them so a developer can match what they see against the contract
//  rather than against this file's phrasing.
//
//  Every string a refusal carries comes from the inspected page, so it is
//  rendered through `textContent` only — never parsed, never interpolated into
//  markup (§11.5).
// ============================================================================

/** What the user can do about a refusal, per class. */
export const guidanceFor = (refusalClass: string): string => {
  switch (refusalClass) {
    case 'VALIDATOR_REJECT':
      // Understood, and not a legal edit of this tree. The edit is the thing
      // to change — the tree is untouched (§8.3).
      return 'The edit is not legal for this tree. Change the edit; nothing was applied.';
    case 'POLICY_DENIED':
      // Understood AND legal. Nothing about the edit can fix this, and saying
      // "try a different value" here would be a lie.
      return "The host's policy layer refused this mutation. No change to the edit will help.";
    case 'NOT_OPTED_IN':
      return 'The host has not enabled relay exposure. Enable its debug flag and reload.';
    case 'CAPABILITY_ABSENT':
      return 'This page does not offer that entry point. It is inspectable, not editable.';
    case 'DECODE_FAILED':
      // The panel composed the op, so this is the panel's defect, not the
      // user's. Saying so is more useful than implying a bad input.
      return 'The host could not decode the op — that is a defect in this panel, not in the edit.';
    case 'NODE_NOT_FOUND':
      // The common cause is a concurrent writer, and the fix is a re-read.
      return 'That node is no longer in the tree. Refresh to see the tree as it is now.';
    case 'SLOT_NOT_DECLARED':
      return 'That slot is not declared on this kind.';
    case 'MALFORMED_MESSAGE':
      return 'The host rejected the request shape — a defect in this panel.';
    case 'FOREIGN_PROFILE':
      return 'The page speaks a relay profile this extension does not. Update one of them.';
    case 'NO_ANSWER':
      // Deliberately NOT phrased as "nothing was applied": a silent host may
      // have applied the op and failed to answer, and claiming otherwise would
      // be the one thing a refusal class promises and this is not.
      return 'The page did not answer. The edit may or may not have been applied — refresh.';
    case 'MALFORMED_RESPONSE':
      return 'The page answered with a shape this extension could not read.';
    default:
      // §10.3: an unrecognised class is the generic case, never a crash. It is
      // still shown by name, because the name is the useful part.
      return 'The host refused this edit.';
  }
};

/** Refusals that mean "the tree moved under you", so a re-read is the response. */
export const impliesStaleTree = (refusalClass: string): boolean =>
  refusalClass === 'NODE_NOT_FOUND' || refusalClass === 'NO_ANSWER';
