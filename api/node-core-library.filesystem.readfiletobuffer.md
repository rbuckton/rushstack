[Home](./index) &gt; [@microsoft/node-core-library](./node-core-library.md) &gt; [FileSystem](./node-core-library.filesystem.md) &gt; [readFileToBuffer](./node-core-library.filesystem.readfiletobuffer.md)

## FileSystem.readFileToBuffer() method

Reads the contents of a file into a buffer. Behind the scenes is uses `fs.readFileSync()`<!-- -->.

<b>Signature:</b>

```typescript
static readFileToBuffer(filePath: string): Buffer;
```

## Parameters

|  Parameter | Type | Description |
|  --- | --- | --- |
|  filePath | `string` | The relative or absolute path to the file whose contents should be read. |

<b>Returns:</b>

`Buffer`
