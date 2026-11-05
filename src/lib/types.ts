export type Role = "owner" | "finance" | "coordinator" | "supplier" | "donor";
export type Actor = {
  id: string;
  name: string;
  role: Role;
  organizationId: string;
  supplierId?: string;
};
export type Organization = {
  id: string;
  name: string;
  description: string;
  sites: { id: string; name: string }[];
  merchantProfile: string;
};
export type Campaign = {
  id: string;
  organizationId: string;
  title: string;
  description: string;
  goal: number;
  targetKits: number;
  status: "draft" | "published" | "closed";
  restricted: boolean;
  fundId: string;
  kitId: string;
  createdAt: string;
};
export type Fund = {
  id: string;
  organizationId: string;
  name: string;
  purpose: string;
  restricted: boolean;
};
export type LedgerEntry = {
  id: string;
  organizationId: string;
  fundId: string;
  amount: number;
  kind:
    | "opening"
    | "donation"
    | "spend"
    | "purchase_refund"
    | "donation_refund"
    | "reversal";
  subjectId: string;
  source: string;
  evidence: "simulation" | "paypal_sandbox";
  createdAt: string;
};
export type Supplier = {
  id: string;
  name: string;
  merchantProfile: string;
  shipping: number;
  organizationIds: string[];
};
export type CatalogItem = {
  id: string;
  supplierId: string;
  sku: string;
  name: string;
  unit: string;
  packSize: number;
  price: number;
  availablePacks: number;
  deliveryDays: number;
  version: number;
  attributes: string[];
  provenance: "synthetic" | "public" | "merchant";
  expiresAt?: string;
};
export type StockLot = {
  id: string;
  organizationId: string;
  siteId: string;
  sku: string;
  name: string;
  quantity: number;
  expiresAt?: string;
  version: number;
  // Absent on legacy lots: do not infer required product suitability.
  attributes?: string[];
};
export type Kit = {
  id: string;
  organizationId: string;
  name: string;
  components: {
    sku: string;
    name: string;
    quantity: number;
    attributes: string[];
  }[];
};
export type PurchaseRequest = {
  id: string;
  replacesRequestId?: string;
  organizationId: string;
  siteId: string;
  kitId: string;
  fundId: string;
  target: number;
  budget: number;
  deadline: string;
  notes: string;
  createdAt: string;
};
export type ProposalLine = {
  catalogId: string;
  supplierId: string;
  sku: string;
  name: string;
  packs: number;
  units: number;
  unitPrice: number;
  cost: number;
  version: number;
  attributes?: string[];
  expiresAt?: string;
};
export type Proposal = {
  id: string;
  organizationId: string;
  requestId: string;
  fundId: string;
  lines: ProposalLine[];
  shipping: number;
  total: number;
  shortages: string[];
  explanations: string[];
  source: "deterministic" | "gemini";
  stockDigest: string;
  digest: string;
  createdAt: string;
};
export type Approval = {
  id: string;
  organizationId: string;
  actorId: string;
  proposalId: string;
  digest: string;
  amount: number;
  fundId: string;
  expiresAt: string;
  consumed: boolean;
};
export type Order = {
  receipt?: { id: string; createdAt: string; movements: StockMovement[] };
  id: string;
  organizationId: string;
  proposalId: string;
  approvalId: string;
  fundId: string;
  supplierId: string;
  siteId: string;
  lines: ProposalLine[];
  total: number;
  cancelledAmount: number;
  status:
    | "awaiting_payer"
    | "uncertain"
    | "paid"
    | "accepted"
    | "partial"
    | "fulfilled"
    | "received"
    | "cancelled";
  providerId?: string;
  captureId?: string;
  approvalUrl?: string;
  evidence: "simulation" | "paypal_sandbox";
  createdAt: string;
};
export type Donation = {
  // A failed provider refund remains financially pending until operator review.
  refundStatus?: "pending" | "failed" | "completed";
  subscriptionId?: string;
  refundId?: string;
  id: string;
  organizationId: string;
  donorId: string;
  campaignId: string;
  fundId: string;
  amount: number;
  net?: number;
  status:
    | "awaiting_payer"
    | "uncertain"
    | "confirmed"
    | "cancelled"
    | "refund_pending"
    | "refunded";
  providerId?: string;
  captureId?: string;
  approvalUrl?: string;
  evidence: "simulation" | "paypal_sandbox";
  createdAt: string;
};
export type Subscription = {
  id: string;
  organizationId: string;
  donorId: string;
  campaignId: string;
  amount: number;
  status: "awaiting_payer" | "active" | "cancelled" | "suspended";
  providerId?: string;
  approvalUrl?: string;
  evidence: "simulation" | "paypal_sandbox";
  createdAt: string;
};
export type Recovery = {
  id: string;
  organizationId: string;
  orderId: string;
  amount: number;
  reason: string;
  status:
    | "opened"
    | "refund_requested"
    | "refund_pending"
    | "refund_confirmed"
    | "replacement_proposed"
    | "resolved"
    | "refund_failed";
  refundId?: string;
  replacementProposalId?: string;
  createdAt: string;
};
export type Audit = {
  id: string;
  organizationId: string;
  actorId: string;
  action: string;
  subjectId: string;
  detail: string;
  createdAt: string;
};
export type Distribution = {
  movements?: StockMovement[];
  components?: { sku: string; quantity: number; attributes?: string[] }[];
  id: string;
  organizationId: string;
  siteId: string;
  kitId: string;
  quantity: number;
  createdAt: string;
};
export type PaymentOperation = {
  id: string;
  subjectId: string;
  action: string;
  profile: string;
  requestId: string;
  status: "started" | "uncertain" | "completed" | "failed";
  providerId?: string;
  error?: string;
  createdAt: string;
};
export type StockMovement = { lotId: string; sku: string; quantity: number };
export type StockCorrection = {
  id: string;
  organizationId: string;
  siteId: string;
  kind: "distribution" | "receipt";
  sourceId: string;
  originalQuantity: number;
  quantity: number;
  movements: StockMovement[];
  reason: string;
  evidence: string;
  proposerId: string;
  createdAt: string;
  expiresAt: string;
  snapshot: string;
  basis?: {
    sourceDigest: string;
    lots: { lotId: string; sku: string; siteId: string; quantity: number; version: number; reserved: number; expiresAt?: string }[];
  };
  digest: string;
  status: "proposed" | "applied" | "rejected";
  approverId?: string;
  appliedAt?: string;
  rejectedBy?: string;
};
export type AgentRun = {
  id: string;
  organizationId: string;
  status: "completed" | "failed";
  source: string;
  evidence: string[];
  createdAt: string;
  error?: string;
};
export type Workspace = {
  stockCorrections?: StockCorrection[];
  // Job-owned progress, persisted with the aggregate lease (not a client cursor).
  reconcileScannedAt?: string;
  reconcileCursor?: string;
  revokedSessionNonces?: Record<string, number>;
  stockReservations: {
    id: string;
    organizationId: string;
    proposalId: string;
    lotId: string;
    quantity: number;
    released: boolean;
  }[];
  id: string;
  revision: number;
  demo: boolean;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  actors: Actor[];
  organizations: Organization[];
  campaigns: Campaign[];
  funds: Fund[];
  ledger: LedgerEntry[];
  suppliers: Supplier[];
  catalog: CatalogItem[];
  inventory: StockLot[];
  kits: Kit[];
  requests: PurchaseRequest[];
  proposals: Proposal[];
  approvals: Approval[];
  orders: Order[];
  donations: Donation[];
  subscriptions: Subscription[];
  recoveries: Recovery[];
  audit: Audit[];
  distributions: Distribution[];
  paymentOperations: PaymentOperation[];
  providerEvents: { id: string; profile: string; receivedAt: string }[];
  agentRuns: AgentRun[];
  dashboards: {
    id: string;
    organizationId: string;
    name: string;
    definition: unknown;
  }[];
  invitations: {
    id: string;
    organizationId: string;
    tokenHash: string;
    role: Role;
    supplierId?: string;
    expiresAt: string;
    used: boolean;
  }[];
  idempotency: Record<string, { fingerprint: string; result: unknown }>;
};
export type Session = {
  workspaceId: string;
  actorId: string;
  expiresAt: number;
  nonce: string;
};
export type AppView = Omit<
  Workspace,
  "idempotency" | "invitations" | "providerEvents" | "revokedSessionNonces"
> & {
  actor: Actor;
  campaignReceived: Record<string, number>;
  available: Record<string, number>;
  reserved: Record<string, number>;
  modes: {
    payments: string;
    ai: string;
    aiPaused: boolean;
    storage: string;
    financialActions: boolean;
  };
  invitations: { id: string; role: Role; expiresAt: string; used: boolean }[];
};
