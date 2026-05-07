---- MODULE efsm ----
\* Executive Function State Machine
\* Formal specification of state space and valid transitions.
\* Corresponds to SQLite implementation in src/efsm/ (Solomon's Key v2).
\*
\* Extraction contract for scripts/verify-efsm.ts:
\*   Each transition operator contains a TRANSITION comment of the form:
\*     state[t] = "PRE" => state'[t] = "POST"
\*   The verifier extracts these lines and checks 1:1 equivalence with
\*   SQL UPDATE patterns in src/efsm/state-machine.ts.

EXTENDS Naturals

CONSTANTS Tasks

VARIABLES state, budget, attempt_count, lease_owner, lease_expires_at

\* ---------------------------------------------------------------------------
\* State space
\* ---------------------------------------------------------------------------

States == {
  "DRAFTED", "PENDING", "EXECUTING", "VERIFYING",
  "COMPLETED", "FAILED", "CANCELLED"
}

TerminalStates == {"COMPLETED", "CANCELLED"}

TypeInvariant ==
  /\ \A t \in Tasks : state[t] \in States
  /\ \A t \in Tasks : budget[t] \in Nat
  /\ \A t \in Tasks : attempt_count[t] \in Nat

\* ---------------------------------------------------------------------------
\* Initial state
\* ---------------------------------------------------------------------------

Init ==
  /\ \A t \in Tasks : state[t] = "DRAFTED"
  /\ \A t \in Tasks : budget[t] > 0
  /\ \A t \in Tasks : attempt_count[t] = 0
  /\ \A t \in Tasks : lease_owner[t] = ""
  /\ \A t \in Tasks : lease_expires_at[t] = 0

\* ---------------------------------------------------------------------------
\* Transition declarations
\* Each operator encodes exactly one valid state transition.
\* The TRANSITION comment is the extraction target for verify-efsm.ts.
\* ---------------------------------------------------------------------------

DraftedToPending(t) ==
  \* TRANSITION state[t] = "DRAFTED" => state'[t] = "PENDING"
  /\ state[t] = "DRAFTED"
  /\ state' = [state EXCEPT ![t] = "PENDING"]
  /\ UNCHANGED <<budget, attempt_count, lease_owner, lease_expires_at>>

PendingToExecuting(t) ==
  \* TRANSITION state[t] = "PENDING" => state'[t] = "EXECUTING"
  /\ state[t] = "PENDING"
  /\ budget[t] > 0
  /\ lease_owner[t] = ""
  /\ state'         = [state         EXCEPT ![t] = "EXECUTING"]
  /\ budget'        = [budget        EXCEPT ![t] = budget[t] - 1]
  /\ attempt_count' = [attempt_count EXCEPT ![t] = attempt_count[t] + 1]
  /\ UNCHANGED <<lease_owner, lease_expires_at>>

PendingToCancelled(t) ==
  \* TRANSITION state[t] = "PENDING" => state'[t] = "CANCELLED"
  /\ state[t] = "PENDING"
  /\ state' = [state EXCEPT ![t] = "CANCELLED"]
  /\ UNCHANGED <<budget, attempt_count, lease_owner, lease_expires_at>>

ExecutingToVerifying(t) ==
  \* TRANSITION state[t] = "EXECUTING" => state'[t] = "VERIFYING"
  /\ state[t] = "EXECUTING"
  /\ state' = [state EXCEPT ![t] = "VERIFYING"]
  /\ UNCHANGED <<budget, attempt_count, lease_owner, lease_expires_at>>

ExecutingToFailed(t) ==
  \* TRANSITION state[t] = "EXECUTING" => state'[t] = "FAILED"
  /\ state[t] = "EXECUTING"
  /\ state'        = [state        EXCEPT ![t] = "FAILED"]
  /\ lease_owner'  = [lease_owner  EXCEPT ![t] = ""]
  /\ UNCHANGED <<budget, attempt_count, lease_expires_at>>

VerifyingToCompleted(t) ==
  \* TRANSITION state[t] = "VERIFYING" => state'[t] = "COMPLETED"
  /\ state[t] = "VERIFYING"
  /\ state'       = [state       EXCEPT ![t] = "COMPLETED"]
  /\ lease_owner' = [lease_owner EXCEPT ![t] = ""]
  /\ UNCHANGED <<budget, attempt_count, lease_expires_at>>

VerifyingToFailed(t) ==
  \* TRANSITION state[t] = "VERIFYING" => state'[t] = "FAILED"
  /\ state[t] = "VERIFYING"
  /\ state'       = [state       EXCEPT ![t] = "FAILED"]
  /\ lease_owner' = [lease_owner EXCEPT ![t] = ""]
  /\ UNCHANGED <<budget, attempt_count, lease_expires_at>>

FailedToPending(t) ==
  \* TRANSITION state[t] = "FAILED" => state'[t] = "PENDING"
  /\ state[t] = "FAILED"
  /\ budget[t] > 0
  /\ state' = [state EXCEPT ![t] = "PENDING"]
  /\ UNCHANGED <<budget, attempt_count, lease_owner, lease_expires_at>>

FailedToCancelled(t) ==
  \* TRANSITION state[t] = "FAILED" => state'[t] = "CANCELLED"
  /\ state[t] = "FAILED"
  /\ state' = [state EXCEPT ![t] = "CANCELLED"]
  /\ UNCHANGED <<budget, attempt_count, lease_owner, lease_expires_at>>

\* ---------------------------------------------------------------------------
\* Next relation — exhaustive union of all valid transitions
\* ---------------------------------------------------------------------------

Next ==
  \E t \in Tasks :
    \/ DraftedToPending(t)
    \/ PendingToExecuting(t)
    \/ PendingToCancelled(t)
    \/ ExecutingToVerifying(t)
    \/ ExecutingToFailed(t)
    \/ VerifyingToCompleted(t)
    \/ VerifyingToFailed(t)
    \/ FailedToPending(t)
    \/ FailedToCancelled(t)

\* ---------------------------------------------------------------------------
\* Invariants
\* ---------------------------------------------------------------------------

\* No task may be in an undefined state.
NoIllegalState ==
  \A t \in Tasks : state[t] \in States

\* Budget is always non-negative.
BudgetNonNegative ==
  \A t \in Tasks : budget[t] >= 0

\* Terminal states are absorbing: once reached, state cannot change.
TerminalStateAbsorbing ==
  \A t \in Tasks :
    state[t] \in TerminalStates => state[t]' = state[t]

\* ---------------------------------------------------------------------------
\* Full specification
\* ---------------------------------------------------------------------------

Spec ==
  Init /\ [][Next]_<<state, budget, attempt_count, lease_owner, lease_expires_at>>

THEOREM Spec => []TypeInvariant
THEOREM Spec => []NoIllegalState
THEOREM Spec => []BudgetNonNegative

====
