# snow-base deployment approval action

This repository publishes a small, dependency-free composite GitHub Action for the
snow-base deployment approval contract. It performs protocol requests only; the
calling repository remains responsible for validation, build output, canonical
artifact creation, platform deployment, and platform credentials.

The public repository contains no service token, private configuration, production
run record, internal resource identifier, or default credential. The production
contract source remains the `packages/shared` contract and the live
`/api/v1/deployments/contracts` endpoint in snow-base.

This initial public distribution is tracked by `SB-RM-084` in the snow-base
planning sidecar. The repository keeps its own independent release history.

Release `v1.0.1` fixes the composite metadata output mapping so callers receive
the values written by the client step, including `artifact-id`.

## Pinned usage

Pin production workflows to the complete commit SHA. The tag is a readable release
alias, not the supply-chain boundary.

```yaml
- name: Request owner approval
  id: approval
  uses: whynotsnow/snow-base-deployment-approval-action@<full-40-char-commit-sha>
  with:
    operation: request-approval
    token: ${{ secrets.DEPLOY_APPROVAL_TOKEN }}
    project-slug: blog
    target: site
    commit-sha: ${{ github.sha }}
    artifact-id: ${{ steps.artifact.outputs.id }}
    artifact-digest: ${{ steps.artifact.outputs.digest }}
    validation-summary: pnpm check passed before approval

- name: Consume owner approval
  uses: whynotsnow/snow-base-deployment-approval-action@<full-40-char-commit-sha>
  with:
    operation: consume-approval
    token: ${{ secrets.DEPLOY_APPROVAL_TOKEN }}
    project-slug: blog
    target: site
    commit-sha: ${{ github.sha }}
    approval-id: ${{ steps.approval.outputs.approval-id }}
    artifact-id: ${{ steps.artifact.outputs.artifact-id }}
    artifact-digest: ${{ steps.artifact.outputs.artifact-digest }}
```

Use the same immutable artifact identity in registration, approval, callback, and
the platform deploy step. Do not use `target: both` for independent deployments.

## Contract

The action reads `https://api.whynotsnow.com` by default. Override `api-base-url`
only for an explicitly configured compatible contract endpoint. Every request uses
`Authorization: Bearer <token>` and accepts the standard `{ ok, data, error }`
response envelope. Network failures and HTTP 5xx responses receive up to two
bounded retries; identity mismatches and API errors fail closed.

Supported operations are:

| Operation | Purpose |
| --- | --- |
| `contract` | Read the current recommended protocol version. |
| `register-artifact` | Register a validated candidate artifact. |
| `request-approval` | Create or reuse an approval request. |
| `wait-approval` | Poll one request until approved or terminal. |
| `get-approval` | Read one approval/request record. |
| `consume-approval` | Verify and consume one approval for an exact identity. |
| `candidate-callback` | Report candidate workflow progress. |
| `deployment-callback` | Report selected deployment workflow progress. |

The action exposes inputs for `operation`, `api-base-url`, `token`, project/target/
commit identity, artifact identity, request/approval IDs, artifact registration
metadata, approval summaries, callback fields, and bounded wait controls. The
complete input schema is the root [`action.yml`](action.yml); token is required and
is passed to the child process through the runner environment, never as an output.

Outputs are `approval-id`, `artifact-id`, `artifact-digest`, `request-id`, `status`,
`reused`, and `protocol-version`. Empty API fields are omitted. A consumer must
still validate that the returned identity matches the artifact it is about to
deploy.

## Compatibility

The action is a transport client for the snow-base contract schema. The current
contract endpoint advertises schema version `1`, primary protocol versions `v1`,
`v1.1`, and `v2`, and recommends `v2`. `v2.x` capabilities are additive profiles,
not a new protocol version. Unknown project/target profiles must be rejected by
the endpoint; this action does not guess a lower protocol or target.

The public action release and the private snow-base contract are intentionally
separate. Downstream projects should upgrade this action only after checking the
endpoint's compatibility profile and should pin the resulting commit SHA in their
production workflow.

## Development

```bash
node --check client.mjs
node --test
```

Tests use a local mock HTTP server. They never contact production and do not need a
service token.
