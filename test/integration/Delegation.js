import {contractId} from "../../utils/helpers"
import {constants} from "../../utils/constants"
import BigNumber from "bignumber.js"
import expectThrow from "../helpers/expectThrow"

const Controller = artifacts.require("Controller")
const BondingManager = artifacts.require("BondingManager")
const AdjustableRoundsManager = artifacts.require("AdjustableRoundsManager")
const LivepeerToken = artifacts.require("LivepeerToken")

contract("Delegation", accounts => {
    const TOKEN_UNIT = 10 ** 18

    let controller
    let bondingManager
    let roundsManager
    let token

    let minterAddr

    let transcoder1
    let transcoder2
    let delegator1
    let delegator2

    let roundLength

    before(async () => {
        transcoder1 = accounts[0]
        transcoder2 = accounts[1]
        delegator1 = accounts[2]
        delegator2 = accounts[3]

        controller = await Controller.deployed()
        await controller.unpause()

        const bondingManagerAddr = await controller.getContract(contractId("BondingManager"))
        bondingManager = await BondingManager.at(bondingManagerAddr)

        const roundsManagerAddr = await controller.getContract(contractId("RoundsManager"))
        roundsManager = await AdjustableRoundsManager.at(roundsManagerAddr)

        const tokenAddr = await controller.getContract(contractId("LivepeerToken"))
        token = await LivepeerToken.at(tokenAddr)

        minterAddr = await controller.getContract(contractId("Minter"))

        const transferAmount = new BigNumber(10).times(TOKEN_UNIT)
        await token.transfer(transcoder1, transferAmount, {from: accounts[0]})
        await token.transfer(transcoder2, transferAmount, {from: accounts[0]})
        await token.transfer(delegator1, transferAmount, {from: accounts[0]})
        await token.transfer(delegator2, transferAmount, {from: accounts[0]})

        roundLength = await roundsManager.roundLength.call()
        await roundsManager.mineBlocks(roundLength.toNumber() * 1000)
        await roundsManager.initializeRound()
    })

    it("registers transcoder 1 that self bonds", async () => {
        await token.approve(bondingManager.address, 1000, {from: transcoder1})
        await bondingManager.bond(1000, transcoder1, {from: transcoder1})
        await bondingManager.transcoder(10, 5, 100, {from: transcoder1})

        assert.equal(await bondingManager.transcoderStatus(transcoder1), 1, "wrong transcoder status")
    })

    it("registers transcoder 2 that self bonds", async () => {
        await token.approve(bondingManager.address, 1000, {from: transcoder2})
        await bondingManager.bond(1000, transcoder2, {from: transcoder2})
        await bondingManager.transcoder(10, 5, 100, {from: transcoder2})

        assert.equal(await bondingManager.transcoderStatus(transcoder2), 1, "wrong transcoder status")
    })

    it("delegator 1 bonds to transcoder 1", async () => {
        await token.approve(bondingManager.address, 1000, {from: delegator1})
        await bondingManager.bond(1000, transcoder1, {from: delegator1})

        const bond = (await bondingManager.getDelegator(delegator1))[0]
        assert.equal(bond, 1000, "delegator 1 bonded amount incorrect")
    })

    it("delegator 2 bonds to transcoder 1", async () => {
        await token.approve(bondingManager.address, 1000, {from: delegator2})
        await bondingManager.bond(1000, transcoder1, {from: delegator2})

        const bond = (await bondingManager.getDelegator(delegator2))[0]
        assert.equal(bond, 1000, "delegator 2 bonded amount incorrect")
    })

    it("delegator 1 delegates to transcoder 2", async () => {
        await bondingManager.bond(0, transcoder2, {from: delegator1})

        const delegate = (await bondingManager.getDelegator(delegator1))[2]
        assert.equal(delegate, transcoder2, "delegator 1 delegate incorrect")
        const delegatedStake = (await bondingManager.getDelegator(transcoder2))[3]
        assert.equal(delegatedStake, 2000, "wrong delegated stake")
    })

    it("delegator 2 delegates to transcoder 2", async () => {
        await bondingManager.bond(0, transcoder2, {from: delegator2})

        const delegate = (await bondingManager.getDelegator(delegator2))[2]
        assert.equal(delegate, transcoder2, "delegator 2 delegate incorrect")
        const delegatedStake = (await bondingManager.getDelegator(transcoder2))[3]
        assert.equal(delegatedStake, 3000, "wrong delegated stake")
    })

    it("delegator 1 delegates more to transcoder 2", async () => {
        const startBond = (await bondingManager.getDelegator(delegator1))[0]

        await token.approve(bondingManager.address, 1000, {from: delegator1})
        await bondingManager.bond(1000, transcoder2, {from: delegator1})

        const endBond = (await bondingManager.getDelegator(delegator1))[0]
        assert.equal(endBond.sub(startBond), 1000, "delegator 1 bonded amount did not increase correctly")
    })

    it("transcoder 1 tries to bond to transcoder 2 and fails", async () => {
        await expectThrow(bondingManager.bond(0, transcoder2, {from: transcoder1}))
    })

    it("delegator 1 unbonds and withdraws its stake", async () => {
        const unbondingPeriod = await bondingManager.unbondingPeriod.call()

        await roundsManager.mineBlocks(roundLength)
        await roundsManager.initializeRound()

        // Delegator 1 unbonds from transcoder 1
        await bondingManager.unbond({from: delegator1})
        await roundsManager.mineBlocks(1)

        let dInfo = await bondingManager.getDelegator(delegator1)
        let currentRound = await roundsManager.currentRound()
        assert.equal(dInfo[2], constants.NULL_ADDRESS, "wrong delegate")
        assert.equal(dInfo[4], 0, "wrong start round")
        assert.equal(dInfo[5], currentRound.add(unbondingPeriod).toNumber(), "wrong withdraw round")
        assert.equal(dInfo[6], currentRound.toNumber(), "wrong last claim round")
        assert.equal((await bondingManager.getDelegator(transcoder1))[3], 1000, "wrong transcoder delegated amount")
        assert.equal(await bondingManager.transcoderTotalStake(transcoder1), 1000, "wrong transcoder total stake")

        // Fast forward through unbonding period
        await roundsManager.mineBlocks(unbondingPeriod.mul(roundLength).toNumber())
        await roundsManager.initializeRound()

        // Delegator 1 withdraws its stake
        const startDelegatorBalance = await token.balanceOf(delegator1)
        const startMinterBalance = await token.balanceOf(minterAddr)
        await bondingManager.withdrawStake({from: delegator1})
        const endDelegatorBalance = await token.balanceOf(delegator1)
        const endMinterBalance = await token.balanceOf(minterAddr)

        dInfo = await bondingManager.getDelegator(delegator1)
        currentRound = await roundsManager.currentRound()
        assert.equal(dInfo[0], 0, "wrong bonded amount")
        assert.equal(dInfo[5], 0, "wrong withdraw round")
        assert.equal(endDelegatorBalance.sub(startDelegatorBalance).toNumber(), 2000, "wrong token balance increase")
        assert.equal(startMinterBalance.sub(endMinterBalance), 2000, "wrong minter balance decrease")
    })

    it("delegator 2 unbonds from transcoder 2 and bonds to transcoder 1", async () => {
        const unbondingPeriod = await bondingManager.unbondingPeriod.call()

        await roundsManager.mineBlocks(roundLength)
        await roundsManager.initializeRound()

        // Delegator 2 unbonds from transcoder 2
        await bondingManager.unbond({from: delegator2})
        await roundsManager.mineBlocks(1)

        let dInfo = await bondingManager.getDelegator(delegator2)
        let currentRound = await roundsManager.currentRound()
        assert.equal(dInfo[2], constants.NULL_ADDRESS, "wrong delegate")
        assert.equal(dInfo[4], 0, "wrong start round")
        assert.equal(dInfo[5], currentRound.add(unbondingPeriod).toNumber(), "wrong withdraw round")
        assert.equal(dInfo[6], currentRound.toNumber(), "wrong last claim round")
        assert.equal((await bondingManager.getDelegator(transcoder2))[3], 1000, "wrong transcoder delegated amount")
        assert.equal(await bondingManager.transcoderTotalStake(transcoder2), 1000, "wrong transcoder total stake")

        // Delegator 2 bonds to transcoder 1 before unbonding period is over
        await bondingManager.bond(0, transcoder1, {from: delegator2})
        await roundsManager.mineBlocks(1)

        dInfo = await bondingManager.getDelegator(delegator2)
        currentRound = await roundsManager.currentRound()
        assert.equal(await bondingManager.delegatorStatus(delegator2), 0, "delegator 2 should be in pending state")
        assert.equal(dInfo[2], transcoder1, "wrong delegate")
        assert.equal(dInfo[4], currentRound.add(1).toNumber(), "wrong start round")
        assert.equal(dInfo[5], 0, "wrong withdraw round")
        assert.equal(dInfo[6], currentRound.toNumber(), "wrong last claim round")
        assert.equal((await bondingManager.getDelegator(transcoder1))[3], 2000, "wrong transcoder delegated amount")
    })

    it("delegator 2 unbonds, does not withdraw its stake and bonds again far in the future", async () => {
        const unbondingPeriod = await bondingManager.unbondingPeriod.call()

        await roundsManager.mineBlocks(roundLength.toNumber())
        await roundsManager.initializeRound()

        // Delegator 2 unbonds from transcoder 1
        await bondingManager.unbond({from: delegator2})

        let dInfo = await bondingManager.getDelegator(delegator2)
        let currentRound = await roundsManager.currentRound()
        assert.equal(dInfo[2], constants.NULL_ADDRESS, "wrong delegate")
        assert.equal(dInfo[4], 0, "wrong start round")
        assert.equal(dInfo[5], currentRound.add(unbondingPeriod).toNumber(), "wrong withdraw round")
        assert.equal(dInfo[6], currentRound.toNumber(), "wrong last claim round")
        assert.equal((await bondingManager.getDelegator(transcoder2))[3], 1000, "wrong transcoder delegated amount")
        assert.equal(await bondingManager.transcoderTotalStake(transcoder2), 1000, "wrong transcoder total stake")

        await roundsManager.mineBlocks(roundLength.toNumber() * 1000)
        await roundsManager.initializeRound()

        // Delegator 2 delegates its bonded stake which has yet to be withdrawn to transcoder 2
        // Should not have to claim rewards and fees for any rounds and should instead just skip to the current round
        await bondingManager.bond(0, transcoder2, {from: delegator2})

        dInfo = await bondingManager.getDelegator(delegator2)
        currentRound = await roundsManager.currentRound()
        assert.equal(dInfo[2], transcoder2, "wrong delegate")
        assert.equal(dInfo[4], currentRound.add(1).toNumber(), "wrong start round")
        assert.equal(dInfo[5], 0, "wrong withdraw round")
        assert.equal(dInfo[6], currentRound.toNumber(), "wrong last claim round")
        assert.equal((await bondingManager.getDelegator(transcoder2))[3], 2000, "wrong transcoder delegated amount")
        assert.equal(await bondingManager.transcoderTotalStake(transcoder2), 2000, "wrong transcoder total stake")
    })
})
