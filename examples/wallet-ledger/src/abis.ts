import { parseAbi } from "viem";

export const erc20Abi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
