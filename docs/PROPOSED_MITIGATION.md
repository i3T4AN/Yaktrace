# Proposed Mitigation: Anonymous Post Correlation via Blocking

## Overview

Yik Yak's current blocking implementation introduces an unintended
privacy vulnerability.

When a user blocks another account, all historical posts authored
by that account disappear from the blocker's feed.

This creates an observable relationship between otherwise anonymous
posts, potentially allowing multiple posts to be attributed to the
same author.

The underlying issue is not the blocking functionality itself,
but its retroactive effect on historical content visibility.

When multiple anonymous posts are correlated to a single author,
seemingly unrelated information can be combined to potentially
identify the individual behind the account.

## Proposed Solution

Modify the blocking mechanism to distinguish between content
published before and after a block was established.

### 1. Preserve Historical Posts

When User A blocks User B:

- Posts authored by User B before the block should remain visible
  to User A.
- Historical posts should not disappear from timelines or API responses.
- User A should retain the ability to view and interact with
  previously published posts, subject to normal interaction restrictions.
- Blocking should not retroactively modify the visibility of
  existing anonymous posts.

**Rationale:**

Preserving historical visibility prevents blocking from functioning
as a mechanism for correlating previously published anonymous posts.

### 2. Restrict Future Content

Once User A blocks User B:

- New posts authored by User B should not appear in User A's feed.
- Posts published after the block should respect the block relationship.
- Existing posts should remain unaffected by subsequent blocking actions.

This preserves the intended purpose of blocking without exposing
historical authorship relationships.

### 3. Handle Comments and Interactions Separately

Comments require additional consideration because historical posts
may continue receiving activity after a block.

Recommended behavior:

- Preserve comments that existed before the block.
- Prevent new direct interactions between the blocked accounts,
  where appropriate.
- Suppress new comments or replies from the blocked account where
  those interactions would violate the block.
- Apply equivalent restrictions to new comments or updates made
  by the original poster on an existing thread.
- Avoid retroactively removing historical comments based solely
  on the current block relationship.

Special care should be taken to ensure that changes in comment
visibility do not introduce another authorship-correlation side channel.

### 4. Maintain Consistent Historical API Responses

The API should apply the same historical visibility rules as the
application interface.

Recommended behavior:

- Historical post visibility should remain stable when accounts
  are blocked or unblocked.
- Previously visible posts should not disappear solely because
  their author was blocked.
- Pagination, post counts, and related metadata should not expose
  historical authorship relationships through block-dependent changes.
- Blocking should not expose account identifiers or other
  author-specific metadata for anonymous content.

## Expected Behavior

| Scenario | Expected Result |
|---|---|
| User A blocks User B | Existing posts remain visible |
| User B published a post before the block | Post remains visible to User A |
| User B publishes a post after the block | Post is hidden from User A |
| User A revisits an older timeline | Historical posts remain visible |
| User A unblocks User B | Historical visibility remains unchanged |
| User B attempts a new restricted interaction | Interaction is blocked |
| Historical comments exist before the block | Comments remain visible |

## Mitigation of Large-Scale Exploitation

The primary objective of this mitigation is to prevent
large-scale, retrospective authorship correlation.

Under the current implementation, blocking retroactively
changes the visibility of historical posts. This allows
previously published content to be correlated without
requiring ongoing observation of user activity.

Consequently, an existing archive of anonymous posts can
be subjected to bulk authorship correlation, potentially
exposing relationships between posts spanning months or
longer periods of activity.

This is particularly concerning for geographically
concentrated communities, such as university campuses,
where correlating otherwise unrelated posts may enable
individual users to be identified through contextual clues.

### Impact of the Proposed Mitigation

The proposed modification eliminates this historical
visibility side channel by preserving posts published
before the block was established.

Although prospective authorship correlation may remain
theoretically possible, it would require observation
of future activity rather than retrospective analysis
of an existing posting history.

Under the proposed behavior, blocking an account would
not reveal which posts that account authored before
the block occurred.

Any remaining correlation through future-content
visibility would be constrained by the passage of time
and the availability of new posts.

This substantially increases the time and resources
required for correlation and prevents the same form
of sequential, large-scale historical analysis.

### Retrospective vs. Prospective Correlation

**Current Implementation:**

- Historical posts are retroactively hidden when their
  author is blocked.
- Previously published content can be correlated without
  waiting for new activity.
- Large historical datasets may be vulnerable to bulk
  authorship correlation.
- The resulting associations can expose accumulated
  personal information across a user's posting history.

**Proposed Implementation:**

- Historical posts remain visible regardless of subsequent
  blocking actions.
- Existing posting history cannot be correlated through
  retroactive block-induced disappearance.
- Any residual correlation based on future content requires
  prospective observation.
- The immediate scalability of historical authorship
  correlation is substantially reduced.

**Security Benefit:**

The distinction between retrospective and prospective
correlation is significant.

A vulnerability that allows historical activity to be
analyzed in bulk presents a substantially different
privacy risk from one requiring ongoing observation
of future activity.

By eliminating retroactive visibility changes, the
proposed mitigation directly addresses the mechanism
enabling large-scale historical authorship correlation.

The objective is not to guarantee that all forms of
deanonymization become impossible, but to eliminate
the specific behavior that makes retrospective,
bulk correlation practical.

## Security Considerations

This proposal addresses the specific issue of retroactive
post visibility changes revealing historical authorship
relationships.

It does not necessarily eliminate every possible
correlation side channel.

In particular, the following behaviors should be
separately evaluated:

- Future-content filtering.
- Comment and reply visibility.
- Post updates and edits.
- Pagination behavior.
- Feed counts and other metadata.
- Block and unblock state transitions.
- Differences between application and API responses.

Any implementation must also preserve appropriate
protections against harassment, unwanted interactions,
and abusive behavior.

If stronger historical blocking protections are required,
alternative designs should be evaluated to ensure those
protections do not inadvertently disclose anonymous
authorship relationships.

The proposed changes should be validated against both
privacy requirements and the intended safety guarantees
of the blocking feature.

## Conclusion

Blocking should primarily affect future content and
interactions rather than retroactively modifying the
visibility of historical anonymous posts.

By separating historical content visibility from future
blocking restrictions, Yik Yak can substantially reduce
the risk of anonymous post correlation while preserving
the core functionality of its blocking system.

Most importantly, this modification addresses the
ability to perform large-scale, retrospective authorship
correlation across an existing collection of posts.

While prospective correlation and other privacy side
channels may remain possible, they should not be confused
with the immediate, bulk historical correlation enabled
by the current implementation.

This represents a targeted mitigation for a significant
privacy vulnerability rather than a comprehensive
guarantee against every possible form of deanonymization.
