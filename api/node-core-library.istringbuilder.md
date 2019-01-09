[Home](./index) &gt; [@microsoft/node-core-library](./node-core-library.md) &gt; [IStringBuilder](./node-core-library.istringbuilder.md)

## IStringBuilder interface

An interface for a builder object that allows a large text string to be constructed incrementally by appending small chunks.

<b>Signature:</b>

```typescript
export interface IStringBuilder 
```

## Methods

|  Method | Description |
|  --- | --- |
|  [append(text)](./node-core-library.istringbuilder.append.md) | Append the specified text to the buffer. |
|  [toString()](./node-core-library.istringbuilder.tostring.md) | Returns a single string containing all the text that was appended to the buffer so far. |

## Remarks

[StringBuilder](./node-core-library.stringbuilder.md) is the default implementation of this contract.
