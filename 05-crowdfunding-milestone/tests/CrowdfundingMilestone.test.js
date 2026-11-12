const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const ETH = (n) => ethers.parseEther(String(n));
const S = { Funding: 0, Failed: 1, Active: 2, Completed: 3 };
const M = { Pending: 0, Voting: 1, Rejected: 2, Released: 3 };
const FUNDING = 3600, VOTING = 600, MS1 = 7 * 86400, MS2 = 7 * 86400;

async function deploy() {
  const [owner, alice, bob, carol, stranger] = await ethers.getSigners();
  const cf = await (await ethers.getContractFactory("CrowdfundingMilestone")).deploy();
  return { cf, owner, alice, bob, carol, stranger };
}

// Goal 10 ETH, milestones 4 + 6 ETH.
async function withCampaign() {
  const f = await deploy();
  await f.cf.connect(f.owner).createCampaign("IoT Farm", "Smart sensors", ETH(10), FUNDING, VOTING, [
    { description: "Prototype", amount: ETH(4), duration: MS1 },
    { description: "Production", amount: ETH(6), duration: MS2 },
  ]);
  return { ...f, id: 1n };
}

// Fully funded: alice 5, bob 3, carol 2 (weights 50% / 30% / 20%).
async function funded() {
  const f = await withCampaign();
  await f.cf.connect(f.alice).contribute(f.id, { value: ETH(5) });
  await f.cf.connect(f.bob).contribute(f.id, { value: ETH(3) });
  await f.cf.connect(f.carol).contribute(f.id, { value: ETH(2) });
  return f;
}

describe("Requirement 1: createCampaign", () => {
  it("stores the campaign and milestones with cumulative deadlines", async () => {
    const { cf, owner, id } = await loadFixture(withCampaign);
    const [c, status] = await cf.getCampaign(id);
    expect(c.owner).to.equal(owner.address);
    expect(c.goal).to.equal(ETH(10));
    expect(status).to.equal(S.Funding);
    const ms = await cf.getMilestones(id);
    expect(ms.length).to.equal(2);
    expect(ms[0].deadline).to.equal(c.deadline + BigInt(MS1));
    expect(ms[1].deadline).to.equal(c.deadline + BigInt(MS1 + MS2));
    expect(await cf.campaignCount()).to.equal(1n);
  });

  it("emits CampaignCreated", async () => {
    const { cf, owner } = await loadFixture(deploy);
    await expect(cf.createCampaign("A", "", ETH(1), 60, 60, [{ description: "x", amount: ETH(1), duration: 60 }]))
      .to.emit(cf, "CampaignCreated");
  });

  it("rejects milestone budgets that do not add up to the goal", async () => {
    const { cf } = await loadFixture(deploy);
    await expect(cf.createCampaign("A", "", ETH(10), 60, 60, [{ description: "x", amount: ETH(9), duration: 60 }]))
      .to.be.revertedWithCustomError(cf, "MilestoneTotalMismatch").withArgs(ETH(10), ETH(9));
  });

  it("rejects bad input", async () => {
    const { cf } = await loadFixture(deploy);
    const one = [{ description: "x", amount: ETH(1), duration: 60 }];
    await expect(cf.createCampaign("", "", ETH(1), 60, 60, one)).to.be.revertedWithCustomError(cf, "EmptyValue");
    await expect(cf.createCampaign("A", "", 0, 60, 60, one)).to.be.revertedWithCustomError(cf, "ZeroValue");
    await expect(cf.createCampaign("A", "", ETH(1), 0, 60, one)).to.be.revertedWithCustomError(cf, "ZeroValue");
    await expect(cf.createCampaign("A", "", ETH(1), 60, 0, one)).to.be.revertedWithCustomError(cf, "ZeroValue");
    await expect(cf.createCampaign("A", "", ETH(1), 60, 60, [])).to.be.revertedWithCustomError(cf, "InvalidMilestoneCount");
    const eleven = Array.from({ length: 11 }, () => ({ description: "x", amount: 1n, duration: 60 }));
    await expect(cf.createCampaign("A", "", 11n, 60, 60, eleven)).to.be.revertedWithCustomError(cf, "InvalidMilestoneCount");
    await expect(cf.createCampaign("A", "", ETH(1), 60, 60, [{ description: "", amount: ETH(1), duration: 60 }]))
      .to.be.revertedWithCustomError(cf, "EmptyValue");
    await expect(cf.createCampaign("A", "", ETH(1), 60, 60, [{ description: "x", amount: ETH(1), duration: 0 }]))
      .to.be.revertedWithCustomError(cf, "ZeroValue");
  });

  it("reverts for unknown campaign ids", async () => {
    const { cf } = await loadFixture(withCampaign);
    await expect(cf.getCampaign(99)).to.be.revertedWithCustomError(cf, "CampaignNotFound").withArgs(99);
    await expect(cf.getCampaign(0)).to.be.revertedWithCustomError(cf, "CampaignNotFound");
  });
});

describe("Requirements 2 and 3: contribute and progress", () => {
  it("tracks contributions, backers and progress", async () => {
    const { cf, alice, id } = await loadFixture(withCampaign);
    await expect(cf.connect(alice).contribute(id, { value: ETH(1) }))
      .to.emit(cf, "Contributed").withArgs(id, alice.address, ETH(1), ETH(1));
    await cf.connect(alice).contribute(id, { value: ETH(2) });
    expect(await cf.contributions(id, alice.address)).to.equal(ETH(3));
    const [raised, goal, timeLeft, backers] = await cf.getFundingProgress(id);
    expect(raised).to.equal(ETH(3));
    expect(goal).to.equal(ETH(10));
    expect(timeLeft).to.be.greaterThan(0n).and.lessThanOrEqual(BigInt(FUNDING));
    expect(backers).to.equal(1n);
  });

  it("does not let the owner contribute", async () => {
    const { cf, owner, id } = await loadFixture(withCampaign);
    await expect(cf.connect(owner).contribute(id, { value: ETH(1) }))
      .to.be.revertedWithCustomError(cf, "OwnerCannotContribute");
  });

  it("rejects zero and amounts above the goal", async () => {
    const { cf, alice, bob, id } = await loadFixture(withCampaign);
    await expect(cf.connect(alice).contribute(id, { value: 0 })).to.be.revertedWithCustomError(cf, "ZeroValue");
    await cf.connect(alice).contribute(id, { value: ETH(9) });
    await expect(cf.connect(bob).contribute(id, { value: ETH(2) }))
      .to.be.revertedWithCustomError(cf, "ExceedsGoal").withArgs(ETH(1));
  });

  it("becomes Active when the goal is reached and stops accepting ETH", async () => {
    const { cf, stranger, id } = await loadFixture(funded);
    expect(await cf.getCampaignStatus(id)).to.equal(S.Active);
    await expect(cf.connect(stranger).contribute(id, { value: 1n }))
      .to.be.revertedWithCustomError(cf, "WrongStatus").withArgs(S.Funding, S.Active);
  });

  it("rejects contributions after the deadline", async () => {
    const { cf, alice, id } = await loadFixture(withCampaign);
    await time.increase(FUNDING);
    const [, , timeLeft] = await cf.getFundingProgress(id);
    expect(timeLeft).to.equal(0n);
    await expect(cf.connect(alice).contribute(id, { value: ETH(1) }))
      .to.be.revertedWithCustomError(cf, "WrongStatus").withArgs(S.Funding, S.Failed);
  });

  it("rejects plain ETH transfers to the contract", async () => {
    const { cf, alice } = await loadFixture(deploy);
    await expect(alice.sendTransaction({ to: await cf.getAddress(), value: 1n })).to.be.reverted;
  });
});

describe("Requirement 4: requestRelease", () => {
  it("opens a vote with the evidence", async () => {
    const { cf, owner, id } = await loadFixture(funded);
    await expect(cf.connect(owner).requestRelease(id, "ipfs://proof1"))
      .to.emit(cf, "MilestoneReleaseRequested");
    const [m0] = await cf.getMilestones(id);
    expect(m0.status).to.equal(M.Voting);
    expect(m0.evidence).to.equal("ipfs://proof1");
    expect(m0.attempts).to.equal(1n);
  });

  it("is owner-only, needs evidence, and needs the goal reached", async () => {
    const { cf, owner, alice, id } = await loadFixture(withCampaign);
    await expect(cf.connect(owner).requestRelease(id, "x"))
      .to.be.revertedWithCustomError(cf, "WrongStatus").withArgs(S.Active, S.Funding);
    const f = await loadFixture(funded);
    await expect(f.cf.connect(f.alice).requestRelease(f.id, "x")).to.be.revertedWithCustomError(f.cf, "NotCampaignOwner");
    await expect(f.cf.connect(f.owner).requestRelease(f.id, "")).to.be.revertedWithCustomError(f.cf, "EmptyValue");
    await f.cf.connect(f.owner).requestRelease(f.id, "x");
    await expect(f.cf.connect(f.owner).requestRelease(f.id, "y")).to.be.revertedWithCustomError(f.cf, "VoteInProgress");
  });

  it("has no way for the owner to withdraw without a vote", async () => {
    const { cf } = await loadFixture(deploy);
    const names = cf.interface.fragments.filter((x) => x.type === "function").map((x) => x.name);
    expect(names.some((n) => /withdraw/i.test(n))).to.equal(false);
  });
});

describe("Requirement 5: vote and finalize", () => {
  it("releases the milestone once more than 50% of contributions approve", async () => {
    const { cf, owner, alice, bob, id } = await loadFixture(funded);
    await cf.connect(owner).requestRelease(id, "proof");
    await cf.connect(alice).voteOnMilestone(id, true); // 50% exactly: not enough
    await expect(cf.finalizeMilestone(id)).to.be.revertedWithCustomError(cf, "VotingStillOpen");
    await cf.connect(bob).voteOnMilestone(id, true); // 80%
    await expect(cf.connect(bob).finalizeMilestone(id)).to.changeEtherBalances(
      [cf, owner], [-ETH(4), ETH(4)]
    );
    const [c] = await cf.getCampaign(id);
    expect(c.totalReleased).to.equal(ETH(4));
    expect(c.currentMilestone).to.equal(1n);
    expect((await cf.getMilestones(id))[0].status).to.equal(M.Released);
  });

  it("treats exactly 50% approval as not passed when voting ends", async () => {
    const { cf, owner, alice, id } = await loadFixture(funded);
    await cf.connect(owner).requestRelease(id, "proof");
    await cf.connect(alice).voteOnMilestone(id, true);
    await time.increase(VOTING);
    await expect(cf.finalizeMilestone(id)).to.emit(cf, "MilestoneRejected").withArgs(id, 0, 1);
  });

  it("rejects early once approval can no longer pass", async () => {
    const { cf, owner, alice, id } = await loadFixture(funded);
    await cf.connect(owner).requestRelease(id, "proof");
    await cf.connect(alice).voteOnMilestone(id, false); // 50% reject
    await expect(cf.finalizeMilestone(id)).to.emit(cf, "MilestoneRejected");
    expect((await cf.getMilestones(id))[0].status).to.equal(M.Rejected);
  });

  it("lets the owner resubmit after rejection, and votes reset", async () => {
    const { cf, owner, alice, bob, id } = await loadFixture(funded);
    await cf.connect(owner).requestRelease(id, "v1");
    await cf.connect(alice).voteOnMilestone(id, false);
    await cf.finalizeMilestone(id);
    await cf.connect(owner).requestRelease(id, "v2");
    expect(await cf.hasVoted(id, 0, alice.address)).to.equal(false);
    await cf.connect(alice).voteOnMilestone(id, true);
    await cf.connect(bob).voteOnMilestone(id, true);
    expect(await cf.hasVoted(id, 0, alice.address)).to.equal(true);
    await expect(cf.finalizeMilestone(id)).to.emit(cf, "MilestoneReleased").withArgs(id, 0, owner.address, ETH(4));
  });

  it("blocks non-backers, double votes and late votes", async () => {
    const { cf, owner, alice, stranger, id } = await loadFixture(funded);
    await expect(cf.connect(alice).voteOnMilestone(id, true)).to.be.revertedWithCustomError(cf, "NoVoteInProgress");
    await cf.connect(owner).requestRelease(id, "proof");
    await expect(cf.connect(stranger).voteOnMilestone(id, true)).to.be.revertedWithCustomError(cf, "NotBacker");
    await expect(cf.connect(owner).voteOnMilestone(id, true)).to.be.revertedWithCustomError(cf, "NotBacker");
    await cf.connect(alice).voteOnMilestone(id, true);
    await expect(cf.connect(alice).voteOnMilestone(id, false)).to.be.revertedWithCustomError(cf, "AlreadyVoted");
    await time.increase(VOTING);
    await expect(cf.connect(owner).voteOnMilestone(id, true)).to.be.reverted;
    const f = await loadFixture(funded);
    await f.cf.connect(f.owner).requestRelease(f.id, "proof");
    await time.increase(VOTING);
    await expect(f.cf.connect(f.bob).voteOnMilestone(f.id, true)).to.be.revertedWithCustomError(f.cf, "VotingClosed");
  });

  it("can finalize an approved vote even after the milestone deadline", async () => {
    const { cf, owner, alice, bob, id } = await loadFixture(funded);
    await cf.connect(owner).requestRelease(id, "proof");
    await cf.connect(alice).voteOnMilestone(id, true);
    await cf.connect(bob).voteOnMilestone(id, true);
    await time.increase(FUNDING + MS1 + 10);
    expect(await cf.getCampaignStatus(id)).to.equal(S.Active);
    await expect(cf.finalizeMilestone(id)).to.emit(cf, "MilestoneReleased");
  });

  it("completes the campaign and pays out exactly the goal", async () => {
    const { cf, owner, alice, bob, id } = await loadFixture(funded);
    for (let i = 0; i < 2; i++) {
      await cf.connect(owner).requestRelease(id, `proof${i}`);
      await cf.connect(alice).voteOnMilestone(id, true);
      await cf.connect(bob).voteOnMilestone(id, true);
      await cf.finalizeMilestone(id);
    }
    const [c, status] = await cf.getCampaign(id);
    expect(status).to.equal(S.Completed);
    expect(c.totalReleased).to.equal(ETH(10));
    expect(await ethers.provider.getBalance(await cf.getAddress())).to.equal(0n);
    await expect(cf.connect(owner).requestRelease(id, "more"))
      .to.be.revertedWithCustomError(cf, "WrongStatus").withArgs(S.Active, S.Completed);
    await expect(cf.connect(alice).claimRefund(id)).to.be.revertedWithCustomError(cf, "WrongStatus");
  });
});

describe("Requirement 6: refunds", () => {
  it("refunds the full contribution when the goal is missed", async () => {
    const { cf, alice, bob, id } = await loadFixture(withCampaign);
    await cf.connect(alice).contribute(id, { value: ETH(3) });
    await cf.connect(bob).contribute(id, { value: ETH(1) });
    await expect(cf.connect(alice).claimRefund(id)).to.be.revertedWithCustomError(cf, "WrongStatus")
      .withArgs(S.Failed, S.Funding);
    await time.increase(FUNDING);
    expect(await cf.getRefundAmount(id, alice.address)).to.equal(ETH(3));
    await expect(cf.connect(alice).claimRefund(id)).to.changeEtherBalances([cf, alice], [-ETH(3), ETH(3)]);
    await expect(cf.connect(alice).claimRefund(id)).to.be.revertedWithCustomError(cf, "AlreadyRefunded");
    expect(await cf.getRefundAmount(id, alice.address)).to.equal(0n);
    await cf.connect(bob).claimRefund(id);
    const [c] = await cf.getCampaign(id);
    expect(c.totalRefunded).to.equal(ETH(4));
    expect(await cf.contributions(id, alice.address)).to.equal(ETH(3)); // history kept
    expect(await ethers.provider.getBalance(await cf.getAddress())).to.equal(0n);
  });

  it("rejects refunds for non-backers", async () => {
    const { cf, alice, stranger, id } = await loadFixture(withCampaign);
    await cf.connect(alice).contribute(id, { value: ETH(1) });
    await time.increase(FUNDING);
    await expect(cf.connect(stranger).claimRefund(id)).to.be.revertedWithCustomError(cf, "NothingToRefund");
  });

  it("fails the campaign when a milestone deadline is missed and refunds what is left", async () => {
    const { cf, owner, alice, bob, carol, id } = await loadFixture(funded);
    await cf.connect(owner).requestRelease(id, "proof");
    await cf.connect(alice).voteOnMilestone(id, true);
    await cf.connect(bob).voteOnMilestone(id, true);
    await cf.finalizeMilestone(id); // 4 ETH paid, 6 ETH left

    await time.increase(FUNDING + MS1 + MS2);
    expect(await cf.getCampaignStatus(id)).to.equal(S.Failed);
    await expect(cf.connect(owner).requestRelease(id, "late"))
      .to.be.revertedWithCustomError(cf, "WrongStatus").withArgs(S.Active, S.Failed);

    // 6 ETH left split 50/30/20 -> 3 / 1.8 / 1.2
    await expect(cf.connect(alice).claimRefund(id)).to.changeEtherBalance(alice, ETH(3));
    await expect(cf.connect(bob).claimRefund(id)).to.changeEtherBalance(bob, ETH(1.8));
    await expect(cf.connect(carol).claimRefund(id)).to.changeEtherBalance(carol, ETH(1.2));
    expect(await ethers.provider.getBalance(await cf.getAddress())).to.equal(0n);
  });

  it("fails when a vote is rejected and the deadline then passes", async () => {
    const { cf, owner, alice, id } = await loadFixture(funded);
    await cf.connect(owner).requestRelease(id, "proof");
    await cf.connect(alice).voteOnMilestone(id, false);
    await time.increase(FUNDING + MS1);
    expect(await cf.getCampaignStatus(id)).to.equal(S.Active); // vote not finalized yet
    await cf.finalizeMilestone(id);
    expect(await cf.getCampaignStatus(id)).to.equal(S.Failed);
    expect(await cf.getRefundAmount(id, alice.address)).to.equal(ETH(5));
  });

  it("blocks a re-entrant double refund", async () => {
    const { cf, alice, id } = await loadFixture(withCampaign);
    const attacker = await (await ethers.getContractFactory("RefundAttacker")).deploy(await cf.getAddress());
    await cf.connect(alice).contribute(id, { value: ETH(3) }); // victim funds to steal
    await attacker.fund(id, { value: ETH(1) });
    await time.increase(FUNDING);
    await expect(attacker.attack()).to.be.revertedWithCustomError(cf, "TransferFailed");
    expect(await ethers.provider.getBalance(await cf.getAddress())).to.equal(ETH(4));
    await expect(cf.connect(alice).claimRefund(id)).to.changeEtherBalance(alice, ETH(3));
  });
});

describe("currentTime", () => {
  it("follows the chain clock, not the computer clock", async () => {
    const { cf } = await loadFixture(deploy);
    const before = await cf.currentTime();
    await time.increase(3600);
    expect(await cf.currentTime()).to.equal(BigInt(await time.latest()));
    expect((await cf.currentTime()) - before).to.be.greaterThanOrEqual(3600n);
  });
});

describe("Two campaigns stay separate", () => {
  it("keeps funds and votes per campaign", async () => {
    const { cf, owner, alice, bob, id } = await loadFixture(funded);
    await cf.connect(bob).createCampaign("Other", "", ETH(1), FUNDING, VOTING, [{ description: "x", amount: ETH(1), duration: MS1 }]);
    await cf.connect(alice).contribute(2, { value: ETH(1) });
    await cf.connect(owner).requestRelease(id, "proof");
    await cf.connect(alice).voteOnMilestone(id, true);
    expect(await cf.hasVoted(2, 0, alice.address)).to.equal(false);
    await expect(cf.hasVoted(2, 5, alice.address)).to.be.revertedWithCustomError(cf, "InvalidMilestoneIndex");
    const [c1] = await cf.getCampaign(id);
    const [c2] = await cf.getCampaign(2);
    expect(c1.totalRaised).to.equal(ETH(10));
    expect(c2.totalRaised).to.equal(ETH(1));
  });
});
