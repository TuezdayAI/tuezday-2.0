export interface CampaignPlanIssue {
  path: string;
  code: string;
  message: string;
}

export class CampaignPlanNotFoundError extends Error {
  constructor(message = "The campaign or plan revision does not exist in this workspace.") {
    super(message);
    this.name = "CampaignPlanNotFoundError";
  }
}

export class PlanImmutableError extends Error {
  constructor() {
    super("Only draft campaign plan revisions can be edited.");
    this.name = "PlanImmutableError";
  }
}

export class PlanValidationError extends Error {
  constructor(public readonly issues: CampaignPlanIssue[]) {
    super("The campaign plan cannot be activated until its validation issues are resolved.");
    this.name = "PlanValidationError";
  }
}
