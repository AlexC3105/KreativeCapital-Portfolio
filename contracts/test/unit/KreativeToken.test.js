// KreativeToken correctness tests (rules R-T*, R-A2/A3/A5 token part, R-X4 token part).
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { KT, TOTAL_SUPPLY, deployTokenFixture } = require("../helpers/fixtures");

const OWNABLE = "Ownable: caller is not the owner";

async function tokenState(token, accounts = []) {
  const addr = await token.getAddress();
  return {
    totalSupply: await token.totalSupply(),
    saleReserve: await token.saleReserve(),
    tokensSold: await token.tokensSold(),
    totalProceeds: await token.totalProceeds(),
    proceedsWithdrawn: await token.proceedsWithdrawn(),
    unwithdrawn: await token.unwithdrawnProceeds(),
    tokenKT: await token.balanceOf(addr),
    tokenETH: await ethers.provider.getBalance(addr),
    balances: await Promise.all(accounts.map((a) => token.balanceOf(a.address))),
    owner: await token.owner(),
    pendingOwner: await token.pendingOwner(),
  };
}

async function setEthBalance(address, wei) {
  await network.provider.send("hardhat_setBalance", [address, ethers.toQuantity(wei)]);
}

describe("KreativeToken", function () {
  describe("supply and initial allocation (T-T01)", function () {
    it("mints exactly 1,000,000 KT (18 decimals) to the token contract's sale reserve", async function () {
      const { token, owner } = await loadFixture(deployTokenFixture);
      expect(await token.name()).to.equal("KreativeToken");
      expect(await token.symbol()).to.equal("KT");
      expect(await token.decimals()).to.equal(18);
      expect(await token.TOTAL_SUPPLY()).to.equal(TOTAL_SUPPLY);
      expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY);
      expect(await token.balanceOf(await token.getAddress())).to.equal(TOTAL_SUPPLY);
      expect(await token.saleReserve()).to.equal(TOTAL_SUPPLY);
      expect(await token.tokensSold()).to.equal(0n);
      expect(await token.balanceOf(owner.address)).to.equal(0n);
      expect(await token.TOKENS_PER_ETH()).to.equal(100n);
      expect(await token.unsolicitedTokenBalance()).to.equal(0n);
      expect(await token.unsolicitedEthBalance()).to.equal(0n);
      expect(await token.unwithdrawnProceeds()).to.equal(0n);
    });
  });

  describe("purchases (T-T02, T-T03)", function () {
    for (const [label, wei] of [
      ["1 wei", 1n],
      ["1 gwei", 10n ** 9n],
      ["0.5 ETH", ethers.parseEther("0.5")],
      ["1 ETH", ethers.parseEther("1")],
      ["an odd wei amount", 123456789123n],
    ]) {
      it(`converts ${label} to exactly value x 100 base units`, async function () {
        const { token, alice } = await loadFixture(deployTokenFixture);
        const expected = wei * 100n;
        await expect(token.connect(alice).buyTokens({ value: wei }))
          .to.emit(token, "TokensPurchased")
          .withArgs(alice.address, wei, expected);
        expect(await token.balanceOf(alice.address)).to.equal(expected);
        expect(await token.saleReserve()).to.equal(TOTAL_SUPPLY - expected);
        expect(await token.tokensSold()).to.equal(expected);
        expect(await token.totalProceeds()).to.equal(wei);
        expect(await token.unwithdrawnProceeds()).to.equal(wei);
        expect(await ethers.provider.getBalance(await token.getAddress())).to.equal(wei);
        expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY);
      });
    }

    it("rejects a zero-value purchase without changing state", async function () {
      const { token, alice } = await loadFixture(deployTokenFixture);
      const before = await tokenState(token, [alice]);
      await expect(token.connect(alice).buyTokens({ value: 0 })).to.be.revertedWithCustomError(token, "ZeroPurchase");
      expect(await tokenState(token, [alice])).to.deep.equal(before);
    });
  });

  describe("reserve exhaustion (T-T04)", function () {
    it("allows buying exactly the remaining reserve and rejects any excess with no partial fill", async function () {
      const { token, alice, bob } = await loadFixture(deployTokenFixture);
      await setEthBalance(alice.address, ethers.parseEther("20000"));
      await token.connect(alice).buyTokens({ value: ethers.parseEther("9999") });
      expect(await token.saleReserve()).to.equal(KT(100));

      const before = await tokenState(token, [bob]);
      const tooMuch = ethers.parseEther("1") + 1n;
      await expect(token.connect(bob).buyTokens({ value: tooMuch }))
        .to.be.revertedWithCustomError(token, "InsufficientReserve")
        .withArgs(tooMuch * 100n, KT(100));
      expect(await tokenState(token, [bob])).to.deep.equal(before);

      await token.connect(bob).buyTokens({ value: ethers.parseEther("1") });
      expect(await token.saleReserve()).to.equal(0n);
      expect(await token.tokensSold()).to.equal(TOTAL_SUPPLY);
      await expect(token.connect(bob).buyTokens({ value: 1n }))
        .to.be.revertedWithCustomError(token, "InsufficientReserve")
        .withArgs(100n, 0n);
    });
  });

  describe("recorded proceeds (T-T05, T-T06, T-T08)", function () {
    it("lets only the owner withdraw exactly the unwithdrawn recorded proceeds; repeats revert", async function () {
      const { token, owner, alice, bob } = await loadFixture(deployTokenFixture);
      await expect(token.connect(owner).withdrawProceeds()).to.be.revertedWithCustomError(token, "NoProceeds");

      const paid = ethers.parseEther("3");
      await token.connect(alice).buyTokens({ value: paid });
      await expect(token.connect(bob).withdrawProceeds()).to.be.revertedWith(OWNABLE);

      const supplyBefore = await token.totalSupply();
      const aliceKT = await token.balanceOf(alice.address);
      const tx = await token.connect(owner).withdrawProceeds();
      await expect(tx).to.emit(token, "ProceedsWithdrawn").withArgs(owner.address, paid);
      await expect(tx).to.changeEtherBalances([token, owner], [-paid, paid]);
      expect(await token.proceedsWithdrawn()).to.equal(paid);
      expect(await token.unwithdrawnProceeds()).to.equal(0n);
      expect(await token.totalProceeds()).to.equal(paid);
      expect(await token.totalSupply()).to.equal(supplyBefore);
      expect(await token.balanceOf(alice.address)).to.equal(aliceKT);

      await expect(token.connect(owner).withdrawProceeds()).to.be.revertedWithCustomError(token, "NoProceeds");

      const more = ethers.parseEther("0.25");
      await token.connect(bob).buyTokens({ value: more });
      await expect(token.connect(owner).withdrawProceeds()).to.changeEtherBalances([token, owner], [-more, more]);
      expect(await token.totalProceeds()).to.equal(paid + more);
      expect(await token.proceedsWithdrawn()).to.equal(paid + more);
    });

    it("rejects plain ETH transfers and never withdraws forced (unsolicited) ETH", async function () {
      const { token, owner, alice } = await loadFixture(deployTokenFixture);
      const addr = await token.getAddress();
      await expect(alice.sendTransaction({ to: addr, value: 1n })).to.be.revertedWithoutReason();
      expect(await ethers.provider.getBalance(addr)).to.equal(0n);

      const paid = ethers.parseEther("2");
      await token.connect(alice).buyTokens({ value: paid });
      const forced = ethers.parseEther("1");
      await setEthBalance(addr, paid + forced); // test-only: simulates ETH forced in without a call
      expect(await token.unsolicitedEthBalance()).to.equal(forced);
      expect(await token.unwithdrawnProceeds()).to.equal(paid);

      await expect(token.connect(owner).withdrawProceeds()).to.changeEtherBalances([token, owner], [-paid, paid]);
      expect(await ethers.provider.getBalance(addr)).to.equal(forced);
      expect(await token.unsolicitedEthBalance()).to.equal(forced);
      await expect(token.connect(owner).withdrawProceeds()).to.be.revertedWithCustomError(token, "NoProceeds");
    });
  });

  describe("unsolicited KT (T-T07)", function () {
    it("does not add KT sent directly to the token contract to the sale reserve", async function () {
      const { token, alice, bob } = await loadFixture(deployTokenFixture);
      const addr = await token.getAddress();
      await token.connect(alice).buyTokens({ value: ethers.parseEther("1") }); // 100 KT
      const reserve = await token.saleReserve();
      await token.connect(alice).transfer(addr, KT(40));
      expect(await token.saleReserve()).to.equal(reserve);
      expect(await token.unsolicitedTokenBalance()).to.equal(KT(40));
      expect(await token.balanceOf(addr)).to.equal(reserve + KT(40));
      expect(await token.tokensSold()).to.equal(KT(100));

      // Capacity is bounded by the recorded reserve, not by the contract balance.
      await setEthBalance(bob.address, ethers.parseEther("20000"));
      const overRecorded = reserve / 100n + 1n;
      await expect(token.connect(bob).buyTokens({ value: overRecorded }))
        .to.be.revertedWithCustomError(token, "InsufficientReserve")
        .withArgs(overRecorded * 100n, reserve);
    });
  });

  describe("failed ETH transfer rollback (T-T09)", function () {
    it("reverts the withdrawal when the owner rejects ETH and keeps proceeds withdrawable", async function () {
      const { token, owner, alice } = await loadFixture(deployTokenFixture);
      const rejector = await ethers.deployContract("MockEthRejector");
      const paid = ethers.parseEther("1");
      await token.connect(alice).buyTokens({ value: paid });
      await token.connect(owner).transferOwnership(await rejector.getAddress());
      await rejector.acceptOwnershipOf(await token.getAddress());
      expect(await token.owner()).to.equal(await rejector.getAddress());

      const data = token.interface.encodeFunctionData("withdrawProceeds");
      const before = await tokenState(token);
      await expect(rejector.forward(await token.getAddress(), data)).to.be.revertedWithCustomError(
        token,
        "EthTransferFailed"
      );
      expect(await tokenState(token)).to.deep.equal(before);

      await rejector.setAcceptEth(true);
      await expect(rejector.forward(await token.getAddress(), data)).to.changeEtherBalances(
        [token, rejector],
        [-paid, paid]
      );
      expect(await token.unwithdrawnProceeds()).to.equal(0n);
    });
  });

  describe("reentrancy on proceeds withdrawal (T-X03 token part)", function () {
    it("blocks an owner contract that re-enters withdrawProceeds; proceeds stay recorded", async function () {
      const { token, owner, alice } = await loadFixture(deployTokenFixture);
      const probe = await ethers.deployContract("MockEthRejector");
      const tokenAddr = await token.getAddress();
      await token.connect(alice).buyTokens({ value: ethers.parseEther("1") });
      await token.connect(owner).transferOwnership(await probe.getAddress());
      await probe.acceptOwnershipOf(tokenAddr);
      await probe.setAcceptEth(true);
      const data = token.interface.encodeFunctionData("withdrawProceeds");
      await probe.setReentry(tokenAddr, data); // receive() re-calls withdrawProceeds
      const before = await tokenState(token);
      // The owner contract accepts ETH, so the only failing step is the re-entrant
      // withdrawProceeds call, which hits ReentrancyGuard; the ETH send then fails as a whole.
      expect(await probe.acceptEth()).to.equal(true);
      await expect(probe.forward(tokenAddr, data)).to.be.revertedWithCustomError(token, "EthTransferFailed");
      expect(await tokenState(token)).to.deep.equal(before);
      // Control: the same receive() re-call mechanism with a harmless, unguarded view call
      // succeeds, so the failure above came from re-entering the guarded function.
      await probe.setReentry(tokenAddr, token.interface.encodeFunctionData("saleReserve"));
      await expect(probe.forward(tokenAddr, data)).to.changeEtherBalance(probe, ethers.parseEther("1"));
    });
  });

  describe("ownership (T-A02, T-A03, T-A05 token part)", function () {
    it("disables renounceOwnership for everyone", async function () {
      const { token, owner, alice } = await loadFixture(deployTokenFixture);
      await expect(token.connect(owner).renounceOwnership()).to.be.revertedWithCustomError(token, "RenounceDisabled");
      await expect(token.connect(alice).renounceOwnership()).to.be.revertedWithCustomError(token, "RenounceDisabled");
      expect(await token.owner()).to.equal(owner.address);
    });

    it("uses two-step transfer; proceeds accrued before the transfer follow the accepted owner role", async function () {
      const { token, owner, alice, bob, carol } = await loadFixture(deployTokenFixture);
      const paid = ethers.parseEther("5");
      await token.connect(alice).buyTokens({ value: paid });

      await expect(token.connect(alice).transferOwnership(bob.address)).to.be.revertedWith(OWNABLE);
      await token.connect(owner).transferOwnership(bob.address);
      expect(await token.owner()).to.equal(owner.address);
      expect(await token.pendingOwner()).to.equal(bob.address);

      await expect(token.connect(bob).withdrawProceeds()).to.be.revertedWith(OWNABLE);
      await expect(token.connect(carol).acceptOwnership()).to.be.revertedWith(
        "Ownable2Step: caller is not the new owner"
      );

      await token.connect(bob).acceptOwnership();
      expect(await token.owner()).to.equal(bob.address);
      expect(await token.pendingOwner()).to.equal(ethers.ZeroAddress);
      expect(await token.unwithdrawnProceeds()).to.equal(paid);

      await expect(token.connect(owner).withdrawProceeds()).to.be.revertedWith(OWNABLE);
      await expect(token.connect(bob).withdrawProceeds()).to.changeEtherBalances([token, bob], [-paid, paid]);
    });
  });
});
