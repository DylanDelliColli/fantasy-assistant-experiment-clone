// Shared records only. Validation stays at the source, context, snapshot and
// session readers that own the data; this module performs no validation.
export const SNAPSHOT_VERSION = 1;
export const DRAFT_STATE_VERSION = 1;
export const BOARD_VERSION = 1;
export const POLICY_VERSION = "draft-v1";

/** @typedef {'QB'|'RB'|'WR'|'TE'|'K'|'DEF'} PolicyPosition */
/** @typedef {'ecr'|'adp-only'} RankingMode */
/**
 * @typedef {Object} SourceMetadata
 * @property {string} url
 * @property {string} season
 * @property {'half-ppr'|null} scoring Provider scoring, never exact custom scoring.
 * @property {string} fetchedAt ISO timestamp; cache reuse preserves original time.
 * @property {string|number|null} updatedAt Original provider value, when supplied.
 */
/**
 * @typedef {Object} Player
 * @property {string} id Canonical Sleeper ID; IDs are never floating-point numbers.
 * @property {string} name
 * @property {string|null} position Sleeper primary position, possibly unsupported.
 * @property {string|null} team
 * @property {boolean} active
 * @property {string[]} fantasyPositions All source eligibility, normalized aliases.
 * @property {PolicyPosition|null} policyPosition Fixed before ECR matching.
 * @property {boolean} eligible Active/current team/supported position and rank or ADP.
 * @property {number|null} adp
 * @property {number|null} adpBand Zero-based fixed 12-place ordinal band, ADP pool only.
 * @property {{sourceId:string,rank:number,tier:number|null,updatedAt:string|number|null}|null} ecr
 * @property {{points:number|null,updatedAt:string|number|null}|null} projection
 * @property {{points:number|null,updatedAt:string|number|null}|null} history
 * @property {{status:string|null,bodyPart:string|null,notes:string|null,updatedAt:string|number|null}} injury
 */
/**
 * @typedef {Object} Config
 * @property {string} leagueId
 * @property {string} draftId
 * @property {string} userId
 * @property {string} rosterId
 * @property {number} slot
 * @property {string} season
 * @property {string} seasonType
 * @property {string} sport
 * @property {string} type
 * @property {number} leagueType
 * @property {number} teams
 * @property {number} rounds
 * @property {number} reversal
 * @property {string[]} rosterPositions
 * @property {number} reserveSlots
 * @property {Record<string,number>} scoring
 * @property {Record<string,number>} draftOrder User ID to draft slot.
 * @property {Record<string,string>} slotToRosterId Slot to roster ID, distinct from slot.
 * @property {Record<string,string[]>} keeperAssignments
 * @property {Object[]} tradedPicks
 */
/**
 * @typedef {Object} Snapshot
 * @property {1} version
 * @property {string} snapshotId
 * @property {string} preparedAt
 * @property {string} leagueName Offline presentation; excluded from fingerprint.
 * @property {Config} config
 * @property {string} configFingerprint
 * @property {Record<string,SourceMetadata>} sources Successfully validated sources.
 * @property {Record<string,Player>} playersById Includes excluded pick identities.
 * @property {RankingMode} rankingMode
 * @property {{coverage:{total:number,positions:Record<string,number>},warnings:string[],quarantine:Object[]}} importReport
 */
/**
 * @typedef {Object} Pick
 * @property {number} pickNo
 * @property {number} round
 * @property {number} slot
 * @property {string} rosterId
 * @property {string} playerId Unknown player IDs remain legal for state handling.
 * @property {string|null} pickedBy Empty upstream picked_by becomes null.
 */
/**
 * @typedef {Object} DraftSnapshot
 * @property {string} draftId
 * @property {string} configFingerprint
 * @property {'pre_draft'|'drafting'|'paused'|'complete'} status
 * @property {Pick[]} picks Complete contiguous history, sorted by pick number.
 * @property {string} fetchedAt
 */
/**
 * @typedef {Object} Correction
 * @property {string} id
 * @property {'taken'|'my-pick'} type
 * @property {string} playerId
 * @property {number|null} pickNo Only own picks occupy a numbered selection.
 */
/**
 * @typedef {Object} DraftState
 * @property {1} version
 * @property {string} configFingerprint
 * @property {number} revision Durable domain token used by expectedRevision.
 * @property {DraftSnapshot|null} accepted Null before validated/saved acceptance;
 * an accepted snapshot with picks=[] is known empty, not unknown availability.
 * @property {{snapshot:DraftSnapshot,revision:number,diff:Object}|null} pending
 * @property {Correction[]} corrections
 * @property {string|null} lastCheckedAt
 * @property {string|null} lastChangedAt
 * @property {string|null} error
 */
/**
 * @typedef {Object} BoardView
 * @property {1} version
 * @property {number} revision Durable action revision; metadata does not change it.
 * @property {string} sessionId New on every openSession, never a durable action token.
 * @property {number} viewRevision Advances on every observable board change,
 * including metadata-only checks and errors. Not used by expectedRevision.
 * @property {RankingMode} rankingMode
 * @property {Object} league
 * @property {Object} draft
 * @property {Object[]} roster
 * @property {number[]} nextPicks
 * @property {Object[]} candidates At most three, with reasons and source values.
 * @property {Player[]} players Searchable identities.
 * @property {Correction[]} corrections
 * @property {Object|null} pending
 * @property {Record<string,SourceMetadata>} sources
 * @property {string|null} lastCheckedAt
 * @property {string|null} lastChangedAt
 * @property {Object} connection
 */
