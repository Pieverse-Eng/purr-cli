import { parseAbi } from 'viem'

export const ERC8183_ABI = parseAbi([
  'function createJob(address provider,address evaluator,uint256 expiredAt,string description,address hook) returns (uint256)',
  'function setBudget(uint256 jobId,uint256 amount,bytes optParams)',
  'function fund(uint256 jobId,uint256 expectedBudget,bytes optParams)',
  'function claimRefund(uint256 jobId)',
  'function getJob(uint256 jobId) view returns ((uint256 id,address client,address provider,address evaluator,string description,uint256 budget,uint256 expiredAt,uint8 status,address hook))',
  'event JobCreated(uint256 indexed jobId,address indexed client,address indexed provider,address evaluator,uint256 expiredAt,address hook)',
])

export const ERC8183_ROUTER_ABI = parseAbi([
  'function registerJob(uint256 jobId,address policy)',
  'function settle(uint256 jobId,bytes evidence)',
  'event JobRegistered(uint256 indexed jobId,address indexed policy,address indexed client)',
  'event JobSettled(uint256 indexed jobId,address indexed policy,uint8 indexed verdict,bytes32 reason)',
])

export const ERC20_ABI = parseAbi([
  'function approve(address spender,uint256 amount) returns (bool)',
])
