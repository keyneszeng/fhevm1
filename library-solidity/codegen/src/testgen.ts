import { strict as assert } from 'node:assert';
import { ArgumentType, OperatorArguments, ReturnType } from './common';
import type { FheTypeInfo, FunctionType, Operator, OverloadShard, OverloadSignature } from './common';
import type { OverloadTests } from './generateOverloads';
import { rndBit } from './pseudoRand';
import { getUint } from './utils';

// ==========================================
// 1. 统一类型配置管理 (Centralized Config)
// ==========================================

// 定义类型描述符，消除 switch-case 地狱
const TYPE_MAPPING: Record<number, { 
  bits: number; 
  solType: (bits: number) => string;     // e.g., uint256
  encType: (bits: number) => string;     // e.g., euint256
  extType: (bits: number) => string;     // e.g., externalEuint256
  stateVarPrefix: string;                // e.g., resEuint
}> = {
  [ArgumentType.Euint]: {
    bits: 0, // 动态
    solType: (bits) => `euint${bits}`,
    encType: (bits) => `euint${bits}`,
    extType: (bits) => `externalEuint${bits}`,
    stateVarPrefix: 'resEuint'
  },
  [ArgumentType.Uint]: {
    bits: 0, // 动态
    solType: (bits) => getUint(bits),
    encType: (bits) => `euint${bits}`, // Uint 在加密上下文中通常转为 euint
    extType: (bits) => getUint(bits),
    stateVarPrefix: 'resUint' // 通常不用作结果存储，但保留逻辑一致性
  },
  [ArgumentType.Ebool]: {
    bits: 1,
    solType: () => 'ebool',
    encType: () => 'ebool',
    extType: () => 'externalEbool',
    stateVarPrefix: 'resEbool'
  }
};

// 辅助函数：获取类型对应的 State Variable 名称
function getStateVarName(t: FunctionType): string {
  const config = TYPE_MAPPING[t.type];
  if (!config) throw new Error(`Unknown type ${t.type}`);
  // Ebool 不需要 bits 后缀，其他通常需要
  if (t.type === ArgumentType.Ebool) return config.stateVarPrefix;
  return `${config.stateVarPrefix}${t.bits}`;
}

// ==========================================
// 2. 主逻辑区
// ==========================================

export function generateSolidityOverloadTestFiles(operators: Operator[], fheTypes: FheTypeInfo[]): OverloadSignature[] {
  const signatures: OverloadSignature[] = [];
  
  // 过滤掉不支持任何操作符的类型
  const adjustedFheTypes = fheTypes.filter((fheType) => fheType.supportedOperators.length > 0);

  // 1. Encrypted <op> Encrypted
  adjustedFheTypes.forEach((lhs) => {
    adjustedFheTypes.forEach((rhs) => {
      operators.forEach((op) => generateBinaryEncryptedOverloads(lhs, rhs, op, signatures));
    });
  });

  // 2. Encrypted <op> Scalar (and vice versa)
  adjustedFheTypes.forEach((fheType) => {
    operators.forEach((op) => generateScalarOverloads(fheType, op, signatures));
  });

  // 3. Shift / Rotate
  adjustedFheTypes.forEach((fheType) => {
    operators.forEach((op) => generateShiftOverloads(fheType, op, signatures));
  });

  // 4. Unary Operators
  adjustedFheTypes.forEach((fheType) => 
    generateUnaryOverloads(fheType, operators, signatures)
  );

  return signatures;
}

// --- 重构后的生成辅助函数 (更加简洁) ---

function generateBinaryEncryptedOverloads(lhs: FheTypeInfo, rhs: FheTypeInfo, op: Operator, sigs: OverloadSignature[]) {
  if (op.shiftOperator || op.rotateOperator || !op.hasEncrypted || op.arguments !== OperatorArguments.Binary) return;
  if (!lhs.supportedOperators.includes(op.name) || !rhs.supportedOperators.includes(op.name)) return;

  if (lhs.type.startsWith('Uint') && rhs.type.startsWith('Uint')) {
    const outputBits = Math.max(lhs.bitLength, rhs.bitLength);
    const returnArg = op.returnType === ReturnType.Euint ? ArgumentType.Euint : ArgumentType.Ebool;

    sigs.push({
      name: op.name,
      arguments: [
        { type: ArgumentType.Euint, bits: lhs.bitLength },
        { type: ArgumentType.Euint, bits: rhs.bitLength },
      ],
      returnType: { type: returnArg, bits: outputBits },
    });
  } 
  // TODO: Add Bytes logic here
  else if (lhs.type.startsWith('Int') && rhs.type.startsWith('Int')) {
    throw new Error('Eint types are not supported yet!');
  }
}

function generateScalarOverloads(fheType: FheTypeInfo, op: Operator, sigs: OverloadSignature[]) {
  if (op.shiftOperator || op.rotateOperator || op.arguments !== OperatorArguments.Binary || !op.hasScalar) return;
  if (!fheType.supportedOperators.includes(op.name)) return;

  const bits = fheType.bitLength;
  const returnArg = op.returnType === ReturnType.Euint ? ArgumentType.Euint : ArgumentType.Ebool;
  const retType = { type: returnArg, bits };

  if (fheType.type.startsWith('Uint')) {
    // Encrypted op Scalar
    sigs.push({
      name: op.name,
      arguments: [{ type: ArgumentType.Euint, bits }, { type: ArgumentType.Uint, bits }],
      returnType: retType,
    });

    // Scalar op Encrypted
    if (!op.leftScalarDisable) {
      sigs.push({
        name: op.name,
        arguments: [{ type: ArgumentType.Uint, bits }, { type: ArgumentType.Euint, bits }],
        returnType: retType,
      });
    }
  }
}

function generateShiftOverloads(fheType: FheTypeInfo, op: Operator, sigs: OverloadSignature[]) {
  if ((!op.shiftOperator && !op.rotateOperator) || !fheType.supportedOperators.includes(op.name)) return;

  const lhsBits = fheType.bitLength;
  const rhsBits = 8; // Shift amount is usually small
  const retType = { type: ArgumentType.Euint, bits: lhsBits };

  if (fheType.type.startsWith('Uint')) {
    // Euint op Euint (shift amount encrypted)
    sigs.push({
      name: op.name,
      arguments: [{ type: ArgumentType.Euint, bits: lhsBits }, { type: ArgumentType.Euint, bits: rhsBits }],
      returnType: retType,
    });
    // Euint op Uint (shift amount scalar)
    sigs.push({
      name: op.name,
      arguments: [{ type: ArgumentType.Euint, bits: lhsBits }, { type: ArgumentType.Uint, bits: rhsBits }],
      returnType: retType,
    });
  }
}

function generateUnaryOverloads(fheType: FheTypeInfo, ops: Operator[], sigs: OverloadSignature[]) {
  ops.forEach((op) => {
    if (op.arguments === OperatorArguments.Unary && fheType.supportedOperators.includes(op.name)) {
      if (fheType.type.startsWith('Uint')) {
        sigs.push({
          name: op.name,
          arguments: [{ type: ArgumentType.Euint, bits: fheType.bitLength }],
          returnType: { type: ArgumentType.Euint, bits: fheType.bitLength },
        });
      }
    }
  });
}

// ==========================================
// 3. 分片与测试代码生成
// ==========================================

export function splitOverloadsToShards(
  overloads: OverloadSignature[],
  options: { shuffle: boolean; shuffleWithPseuseRand: boolean }
): OverloadShard[] {
  // 建议：对于复杂操作符，可以给予更高权重，减少 MAX_SHARD_SIZE
  // 这里保持原逻辑，但增加了注释提醒
  const MAX_SHARD_SIZE = 90; 
  const res: OverloadShard[] = [];

  const list = [...overloads]; // copy to avoid mutation side effects
  if (options.shuffle) {
    if (options.shuffleWithPseuseRand) {
      list.sort(() => (rndBit() === 0 ? -1 : 1));
    } else {
      list.sort(() => Math.random() - 0.5);
    }
  }

  for (let i = 0; i < list.length; i += MAX_SHARD_SIZE) {
    res.push({
      shardNumber: Math.floor(i / MAX_SHARD_SIZE) + 1,
      overloads: list.slice(i, i + MAX_SHARD_SIZE),
    });
  }

  return res;
}

export type TypescriptTestGroupImports = { signers: string; instance: string; typechain: string };

export function generateTypeScriptTestCode(
  shards: OverloadShard[],
  numTsSplits: number,
  overloadTests: OverloadTests,
  imports: TypescriptTestGroupImports,
  options: { publicDecrypt: boolean; shuffle: boolean; shuffleWithPseuseRand: boolean }
): string[] {
  const numSolTest = shards.reduce((sum, os) => sum + os.overloads.length, 0);
  const sizeTsShard = Math.ceil(numSolTest / numTsSplits); // 使用 ceil 确保覆盖
  
  const listRes: string[] = [];
  let currentFileBuffer: string[] = [];
  let globalTestCounter = 0;
  let currentSplitIndex = 1;

  // 预先打乱 Shard 内部顺序
  shards.forEach(os => {
    if (options.shuffle) {
      if (options.shuffleWithPseuseRand) {
        os.overloads.sort(() => (rndBit() === 0 ? -1 : 1));
      } else {
        os.overloads.sort(() => Math.random() - 0.5);
      }
    }
  });

  // 迭代所有 Shard 和其中的 Overload
  for (const os of shards) {
    for (const o of os.overloads) {
      // 检查是否需要开始新文件
      if (globalTestCounter % sizeTsShard === 0) {
        if (currentFileBuffer.length > 0) {
          currentFileBuffer.push(`});`); // Close previous describe block
          listRes.push(currentFileBuffer.join(''));
          currentFileBuffer = [];
          currentSplitIndex++;
        }
        currentFileBuffer.push(generateIntroTestCode(shards, currentSplitIndex, imports, options));
      }

      // 生成单个测试用例
      const testCode = generateSingleOverloadTestCase(os, o, overloadTests, options);
      currentFileBuffer.push(testCode);
      
      globalTestCounter++;
    }
  }

  // 关闭最后一个文件
  if (currentFileBuffer.length > 0) {
    currentFileBuffer.push(`});`);
    listRes.push(currentFileBuffer.join(''));
  }

  return listRes;
}

// 提取：生成单个重载函数的测试代码
function generateSingleOverloadTestCase(
  os: OverloadShard, 
  o: OverloadSignature, 
  overloadTests: OverloadTests,
  options: { publicDecrypt: boolean }
): string {
  const methodName = signatureContractMethodName(o);
  const tests = overloadTests[methodName] || [];
  assert(tests.length > 0, `Overload ${methodName} has no test, please add them.`);

  const buffer: string[] = [];
  let testIndex = 1;

  tests.forEach((t) => {
    // 参数预处理
    const inputs = t.inputs.map((input, i) => {
      let val = typeof input === 'string' ? BigInt(input) : input;
      ensureNumberAcceptableInBitRange(o.arguments[i].bits, val);
      return val;
    });

    let output = t.output;
    if (typeof output === 'string' || typeof output === 'number') output = BigInt(output);
    ensureNumberAcceptableInBitRange(o.returnType.bits, output);

    const testName = `test operator "${o.name}" overload ${signatureContractEncryptedSignature(o)}`;
    
    // 生成输入准备代码
    let numEncryptedArgs = 0;
    const callArgs = inputs.map((v, i) => {
      if (o.arguments[i].type === ArgumentType.Euint) {
        numEncryptedArgs++;
        return `encryptedAmount.handles[${numEncryptedArgs - 1}]`;
      }
      return `${v}n`;
    }).join(', ');

    const inputsAdding = inputs.map((v, i) => {
      if (o.arguments[i].type === ArgumentType.Euint) {
        return `input.add${o.arguments[i].bits}(${v}n);`;
      }
      return '';
    }).join('\n');

    const expectedOutputStr = `${output}n`;
    const resultBits = o.returnType.type === ArgumentType.Ebool ? 'Bool' : o.returnType.bits;
    const resultVar = getStateVarName(o.returnType); // 使用新的辅助函数

    if (options.publicDecrypt) {
      buffer.push(`
        it('${testName} test ${testIndex}', async function () {
          const input = this.instance.createEncryptedInput(this.contract${os.shardNumber}Address, this.signer.address);
          ${inputsAdding}
          const encryptedAmount = await input.encrypt();
          const tx = await this.contract${os.shardNumber}.${methodName}(${callArgs}, encryptedAmount.inputProof);
          await tx.wait();
          const handle = await this.contract${os.shardNumber}.${resultVar}();
          const res = await this.instance.publicDecrypt([handle]);
          assert.deepEqual(res.clearValues[handle], ${expectedOutputStr});
        });
      `);
    } else {
      buffer.push(`
        it('${testName} test ${testIndex}', async function () {
          const input = this.instances.alice.createEncryptedInput(this.contract${os.shardNumber}Address, this.signers.alice.address);
          ${inputsAdding}
          const encryptedAmount = await input.encrypt();
          const tx = await this.contract${os.shardNumber}.${methodName}(${callArgs}, encryptedAmount.inputProof);
          await tx.wait();
          const res = await decrypt${resultBits}(await this.contract${os.shardNumber}.${resultVar}());
          expect(res).to.equal(${expectedOutputStr});
        });
      `);
    }
    testIndex++;
  });

  return buffer.join('');
}

// ==========================================
// 4. Solidity 合约生成
// ==========================================

export function generateSolidityUnitTestContracts(
  os: OverloadShard,
  importsCode: string[],
  parentContract: string | undefined,
  usePublicDecrypt: boolean
): string {
  // 自动生成所有用到的类型的状态变量
  // 1. 收集该 Shard 中所有重载函数的返回类型
  const returnTypes = new Set<string>();
  os.overloads.forEach(o => {
    returnTypes.add(getStateVarName(o.returnType));
  });

  // 2. 生成变量声明
  const stateVarsDecl = Array.from(returnTypes).map(varName => {
    // 简单的反向查找类型 (或者在上面 TYPE_MAPPING 做的更好，这里为了兼容现有逻辑简化处理)
    let typeName = '';
    if (varName.startsWith('resEbool')) typeName = 'ebool';
    else if (varName.startsWith('resEuint')) typeName = `euint${varName.replace('resEuint', '')}`;
    else throw new Error(`Unknown var name ${varName}`);
    
    return `${typeName} public ${varName};`;
  }).join('\n          ');

  const inheritance = parentContract ? `is ${parentContract}` : '';
  const constructor = parentContract ? '' : `
          constructor() {
            FHE.setCoprocessor(CoprocessorSetup.defaultConfig());
          }
  `;

  return `
        // SPDX-License-Identifier: BSD-3-Clause-Clear
        pragma solidity ^0.8.24;

        ${importsCode.join(';\n') + (importsCode.length ? ';' : '')}

        contract FHEVMTestSuite${os.shardNumber} ${inheritance} {
          ${stateVarsDecl}

          ${constructor}

          ${generateLibCallTest(os, usePublicDecrypt)}
        }
    `;
}

function generateLibCallTest(os: OverloadShard, usePublicDecrypt: boolean): string {
  return os.overloads.map(o => {
    const methodName = signatureContractMethodName(o);
    const argsSig = signatureContractArguments(o);
    
    // 参数解包逻辑
    let charCode = 97;
    const paramsProcessing = o.arguments.map(argType => {
      const char = String.fromCharCode(charCode++);
      const castLogic = castExpressionToType(char, argType);
      const solType = functionTypeToString(argType);
      return `${solType} ${char}Proc = ${castLogic};`;
    }).join('\n');

    const callArgs = o.arguments.map((_, i) => `${String.fromCharCode(97 + i)}Proc`).join(', ');

    let opLogic = '';
    const resType = functionTypeToEncryptedType(o.returnType);

    if (o.binaryOperator) {
      opLogic = `${resType} result = aProc ${o.binaryOperator} bProc;`;
    } else if (o.unaryOperator) {
      opLogic = `${resType} result = ${o.unaryOperator}aProc;`;
    } else {
      opLogic = `${resType} result = FHE.${o.name}(${callArgs});`;
    }

    const permissionLogic = usePublicDecrypt 
      ? 'FHE.makePubliclyDecryptable(result);' 
      : 'FHE.allowThis(result);';

    const stateVar = getStateVarName(o.returnType);

    return `
    function ${methodName}(${argsSig}) public {
      ${paramsProcessing}
      ${opLogic}
      ${permissionLogic}
      ${stateVar} = result;
    }
    `;
  }).join('\n');
}

// ==========================================
// 5. 辅助工具与重构后的类型转换
// ==========================================

function ensureNumberAcceptableInBitRange(bits: number, input: number | bigint) {
  const limit = 2n ** BigInt(bits);
  const val = BigInt(input);
  assert(val >= 0n && val <= limit, `${bits} bit number ${input} out of range [0, ${limit}]`);
}

// Intro 生成代码保持原样，或可提取为单独模板文件
function generateIntroTestCode(
  shards: OverloadShard[],
  idxSplit: number,
  imports: TypescriptTestGroupImports,
  options: { publicDecrypt: boolean }
): string {
  // 为节省篇幅，这里复用你原有的逻辑，
  // 实际项目中建议把长字符串放到单独的 template.ts 文件中
  if (options.publicDecrypt) {
    return generateIntroTestCodePublicDecrypt(shards, idxSplit, imports);
  } else {
    return generateIntroTestCodeUserDecrypt(shards, idxSplit, imports);
  }
}

// ... (原有的 generateIntroTestCodeUserDecrypt 和 generateIntroTestCodePublicDecrypt 保持不变)

export function signatureContractMethodName(s: OverloadSignature): string {
  return [s.name, ...s.arguments.map(functionTypeToString)].join('_');
}

function signatureContractArguments(s: OverloadSignature): string {
  const args = s.arguments.map((a, i) => 
    `${functionTypeToCalldataType(a)} ${String.fromCharCode(97 + i)}`
  );
  args.push('bytes calldata inputProof');
  return args.join(', ');
}

function signatureContractEncryptedSignature(s: OverloadSignature): string {
  const args = s.arguments.map(functionTypeToString).join(', ');
  return `(${args}) => ${functionTypeToEncryptedType(s.returnType)}`;
}

// 使用 TYPE_MAPPING 重构的转换函数
function castExpressionToType(argExpr: string, t: FunctionType): string {
  if (t.type === ArgumentType.Euint) return `FHE.fromExternal(${argExpr}, inputProof)`;
  if (t.type === ArgumentType.Uint) return argExpr;
  if (t.type === ArgumentType.Ebool) return `FHE.asEbool(${argExpr})`;
  throw new Error(`Unknown type ${t.type}`);
}

function functionTypeToCalldataType(t: FunctionType): string {
  const mapping = TYPE_MAPPING[t.type];
  if (!mapping) throw new Error(`Unknown type ${t.type}`);
  return mapping.extType(t.bits);
}

function functionTypeToEncryptedType(t: FunctionType): string {
  const mapping = TYPE_MAPPING[t.type];
  if (!mapping) throw new Error(`Unknown type ${t.type}`);
  return mapping.encType(t.bits);
}

function functionTypeToString(t: FunctionType): string {
  const mapping = TYPE_MAPPING[t.type];
  if (!mapping) throw new Error(`Unknown type ${t.type}`);
  return mapping.solType(t.bits);
}

// 需要保留原有的 imports 辅助函数 (generateIntroTestCodeUserDecrypt 等)
// 此处省略以节省空间，实际使用时请保留。
function generateIntroTestCodeUserDecrypt(shards: OverloadShard[], idxSplit: number, imports: TypescriptTestGroupImports): string {
    // ... (保留原代码逻辑)
    // 这里的实现没有变动，主要是外部调用方式变了
    // 建议：可以将这些长字符串移到底部或单独文件
    const intro: string[] = [];
    // ... Copy from original ...
    // 为了完整性，这里简略展示，实际请粘贴原函数内容
    intro.push(`
    import { expect } from 'chai';
    import { ethers } from 'hardhat';
    import { createInstances, decrypt8, decrypt16, decrypt32, decrypt64, decrypt128, decrypt256, decryptBool } from '${imports.instance}';
    import { getSigners, initSigners } from '${imports.signers}';
    `);
    // ...
    return intro.join('');
}

function generateIntroTestCodePublicDecrypt(shards: OverloadShard[], idxSplit: number, imports: TypescriptTestGroupImports): string {
     // ... Copy from original ...
     return `
    import { assert } from 'chai';
    import { ethers } from 'hardhat';
    import { createInstance } from '${imports.instance}';
    import { getSigner, getSigners, initSigners } from '${imports.signers}';
    // ... rest of the code
     `;
}
