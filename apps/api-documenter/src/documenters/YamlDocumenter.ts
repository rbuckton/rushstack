// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

// tslint:disable:member-ordering

import * as path from 'path';

import yaml = require('js-yaml');
import {
  JsonFile,
  JsonSchema,
  PackageName,
  FileSystem,
  NewlineKind,
  InternalError
} from '@microsoft/node-core-library';
import { StringBuilder, DocSection, DocComment } from '@microsoft/tsdoc';
import {
  ApiModel,
  ApiItem,
  ApiItemKind,
  ApiDocumentedItem,
  ApiReleaseTagMixin,
  ReleaseTag,
  ApiPropertyItem,
  ApiItemContainerMixin,
  ApiPackage,
  ApiEnumMember,
  ApiClass,
  ApiInterface,
  ApiParameterListMixin,
  ApiMethod,
  ApiMethodSignature,
  ApiConstructor,
  ApiFunction,
  ApiReturnTypeMixin,
  ApiTypeParameterListMixin,
  Excerpt,
  ExcerptToken,
  ExcerptTokenKind
} from '@microsoft/api-extractor-model';

import {
  IYamlApiFile,
  IYamlItem,
  IYamlSyntax,
  IYamlParameter,
  IYamlReference,
  IYamlReferenceSpec
} from '../yaml/IYamlApiFile';
import {
  IYamlTocFile,
  IYamlTocItem
} from '../yaml/IYamlTocFile';
import { Utilities } from '../utils/Utilities';
import { CustomMarkdownEmitter} from '../markdown/CustomMarkdownEmitter';

const yamlApiSchema: JsonSchema = JsonSchema.fromFile(path.join(__dirname, '..', 'yaml', 'typescript.schema.json'));

interface IYamlReferenceData {
  references: IYamlReference[];
  recordedUids: Set<string>;
  excerptToUidMap: Map<string, string>;
  anonymousTypeCounter: number;
}

interface IApiItemData {
  uid: string;
  possiblyAmbiguousTocDisplayName: string;
  unambiguousTocDisplayName: string;
  /**
   * Stores the uids of any declarations with a colliding name.
   */
  collisions: ReadonlySet<string> | undefined;
}

const enum FilterChildrenFlags {
  NonNamespace,
  FlatNamespace,
  All
}

/**
 * Writes documentation in the Universal Reference YAML file format, as defined by typescript.schema.json.
 */
export class YamlDocumenter {
  private readonly _apiModel: ApiModel;
  private readonly _markdownEmitter: CustomMarkdownEmitter;

  // This is used by the _linkToUidIfPossible() workaround.
  // It stores a mapping from type name (e.g. "MyClass") to the corresponding ApiItem.
  // If the mapping would be ambiguous (e.g. "MyClass" is defined by multiple packages)
  // then it is excluded from the mapping.  Also excluded are ApiItem objects (such as package
  // and function) which are not typically used as a data type.
  private _apiItemsByTypeName: Map<string, ApiItem>;
  private _apiItemsByUid: Map<string, ApiItem>;
  private _knownTypeParameters: Set<string> | undefined;
  private _apiItemData: ReadonlyMap<ApiItem, IApiItemData>;
  private _yamlReferenceData: IYamlReferenceData | undefined;

  private _outputFolder: string;

  public constructor(apiModel: ApiModel) {
    this._apiModel = apiModel;
    this._markdownEmitter = new CustomMarkdownEmitter(this._apiModel);
    this._apiItemsByTypeName = new Map<string, ApiItem>();
    this._apiItemsByUid = new Map<string, ApiItem>();
    this._apiItemData = this._initApiItemData();

    this._initApiItemsByTypeName();
  }

  /** @virtual */
  public generateFiles(outputFolder: string): void {
    this._outputFolder = outputFolder;

    console.log();
    this._deleteOldOutputFiles();

    for (const apiPackage of this._apiModel.packages) {
      console.log(`Writing ${apiPackage.name} package`);
      this._visitApiItems(apiPackage, undefined);
    }

    this._writeTocFile(this._apiModel.packages);
  }

  /** @virtual */
  protected onGetTocRoot(): IYamlTocItem {
    return {
      name: 'SharePoint Framework reference',
      href: '~/overview/sharepoint.md',
      items: [ ]
    };
  }

  /** @virtual */
  protected onCustomizeYamlItem(yamlItem: IYamlItem): void { // virtual
    // (overridden by child class)
  }

  private _visitApiItems(apiItem: ApiDocumentedItem, parentYamlFile: IYamlApiFile | undefined): boolean {
    const savedKnownTypeParameters: Set<string> | undefined = this._knownTypeParameters;
    try {
      // Track type parameters declared by a declaration so that we do not resolve them
      // when looking up types in _linkToUidIfPossible()
      if (ApiTypeParameterListMixin.isBaseClassOf(apiItem)) {
        this._knownTypeParameters = savedKnownTypeParameters
          ? new Set(savedKnownTypeParameters)
          : new Set();
        for (const typeParameter of apiItem.typeParameters) {
          this._knownTypeParameters.add(typeParameter.name);
        }
      }

      const yamlItem: IYamlItem | undefined = this._generateYamlItem(apiItem);
      if (!yamlItem) {
        return false;
      }

      this.onCustomizeYamlItem(yamlItem);

      if (this._shouldEmbed(apiItem.kind)) {
        if (!parentYamlFile) {
          throw new InternalError('Missing file context');
        }
        parentYamlFile.items.push(yamlItem);
      } else {
        const newYamlFile: IYamlApiFile = {
          items: []
        };
        newYamlFile.items.push(yamlItem);

        let children: ReadonlyArray<ApiItem>;
        if (apiItem.kind === ApiItemKind.Package) {
          // Skip over the entry point, since it's not part of the documentation hierarchy
          children = this._filterChildren(apiItem.members[0].members, FilterChildrenFlags.All);
        } else {
          children = this._filterChildren(apiItem.members, FilterChildrenFlags.NonNamespace);
        }

        for (const child of children) {
          if (child instanceof ApiDocumentedItem) {
            if (this._visitApiItems(child, newYamlFile)) {
              if (!yamlItem.children) {
                yamlItem.children = [];
              }
              yamlItem.children.push(this._getUid(child));
            }
          }
        }

        if (this._yamlReferenceData) {
          if (this._yamlReferenceData.references.length > 0) {
            if (newYamlFile.references) {
              newYamlFile.references = [...newYamlFile.references, ...this._yamlReferenceData.references];
            } else {
              newYamlFile.references = this._yamlReferenceData.references;
            }
          }
          this._yamlReferenceData = undefined;
        }

        const yamlFilePath: string = this._getYamlFilePath(apiItem);

        if (apiItem.kind === ApiItemKind.Package) {
          console.log('Writing ' + yamlFilePath);
        }

        this._writeYamlFile(newYamlFile, yamlFilePath, 'UniversalReference', yamlApiSchema);

        if (parentYamlFile) {
          if (!parentYamlFile.references) {
            parentYamlFile.references = [];
          }

          parentYamlFile.references.push({
            uid: this._getUid(apiItem),
            name: this._getYamlItemName(apiItem)
          });

        }
      }

      return true;
    } finally {
      this._knownTypeParameters = savedKnownTypeParameters;
    }
  }

  // The YAML Schema requires that namespaces be flattened, so we can pass one of three options:
  // - FilterChildrenFlags.All: Returns all the non-namespace children and all of the nested namespaces
  //   excluding their non-namespace children
  // - FilterChildrenFlags.NonNamespace: Returns all the non-namespace children only.
  // - FilterChildrenFlags.Namespace: Returns nested namespaces only (only used when _filterChildren
  //   calls itself recursively as part of FilterChildrenFlags.All)
  private _filterChildren(items: ReadonlyArray<ApiItem>, filter: FilterChildrenFlags): ApiItem[] {
    const filtered: ApiItem[] = [];
    for (const item of items) {
      if (item.kind === ApiItemKind.Namespace) {
        if (filter === FilterChildrenFlags.FlatNamespace ||
            filter === FilterChildrenFlags.All) {
          filtered.push(item);
          filtered.push(...this._filterChildren(item.members, FilterChildrenFlags.FlatNamespace));
        }
      } else {
        if (filter === FilterChildrenFlags.NonNamespace ||
            filter === FilterChildrenFlags.All) {
          filtered.push(item);
        }
      }
    }
    return filtered;
  }

  /**
   * Write the table of contents
   */
  private _writeTocFile(apiItems: ReadonlyArray<ApiItem>): void {
    const tocFile: IYamlTocFile = this.buildYamlTocFile(apiItems);

    for (const tocItem of tocFile.items) {
      this._disambiguateTocItem(tocItem, tocFile.items);
    }

    const tocFilePath: string = path.join(this._outputFolder, 'toc.yml');
    console.log('Writing ' + tocFilePath);
    this._writeYamlFile(tocFile, tocFilePath, '', undefined);
  }

  private _disambiguateTocItem(tocItem: IYamlTocItem, siblings: IYamlTocItem[]): void {
    // Disambiguate tocItem if it has a sibling with a colliding name
    if (tocItem.uid && siblings.length > 1) {
      const apiItem: ApiItem | undefined = this._apiItemsByUid.get(tocItem.uid);
      const itemData: IApiItemData | undefined = apiItem && this._apiItemData.get(apiItem);
      // Only disambiguate if the tocItem's name is still the ambiguous name.
      if (itemData && tocItem.name === itemData.possiblyAmbiguousTocDisplayName) {
        // Check whether any sibling's uid is in the list of collisions.
        let hasCollision: boolean = false;
        if (itemData.collisions) {
          for (const sibling of siblings) {
            if (sibling !== tocItem && sibling.uid && itemData.collisions.has(sibling.uid)) {
              hasCollision = true;
              break;
            }
          }
        }
        if (hasCollision) {
          tocItem.name = itemData.unambiguousTocDisplayName;
        }
      }
    }

    if (tocItem.items) {
      for (const childTocItem of tocItem.items) {
        this._disambiguateTocItem(childTocItem, tocItem.items);
      }
    }
  }

  /** @virtual */
  protected buildYamlTocFile(apiItems: ReadonlyArray<ApiItem>): IYamlTocFile {
    const tocFile: IYamlTocFile = {
      items: [ ]
    };

    const rootItem: IYamlTocItem = this.onGetTocRoot();
    tocFile.items.push(rootItem);

    rootItem.items!.push(...this.buildTocItems(apiItems));
    return tocFile;
  }

  /** @virtual */
  protected onCustomizeYamlTocItem(yamlTocItem: IYamlTocItem, apiItem: ApiItem): void { // virtual
    // (overridden by child class)
  }

  protected buildTocItems(apiItems: ReadonlyArray<ApiItem>): IYamlTocItem[] {
    const tocItems: IYamlTocItem[] = [];
    for (const apiItem of apiItems) {
      let tocItem: IYamlTocItem;

      if (this._shouldEmbed(apiItem.kind)) {
        // Don't generate table of contents items for embedded definitions
        continue;
      }

      // Create the item initially with the possibly ambiguous display name. We will disambiguate
      // sibling toc items in a later pass in case a subclass generates a different TOC.
      tocItem = {
        name: this.getPossiblyAmbiguousTocDisplayName(apiItem),
        uid: this._getUid(apiItem)
      };

      this.onCustomizeYamlTocItem(tocItem, apiItem);
      tocItems.push(tocItem);

      let children: ReadonlyArray<ApiItem>;
      if (apiItem.kind === ApiItemKind.Package) {
        // Skip over the entry point, since it's not part of the documentation hierarchy
        children = this._filterChildren(apiItem.members[0].members, FilterChildrenFlags.All);
      } else {
        children = this._filterChildren(apiItem.members, FilterChildrenFlags.NonNamespace);
      }

      const childItems: IYamlTocItem[] = this.buildTocItems(children);
      if (childItems.length > 0) {
        tocItem.items = childItems;
      }
    }
    return tocItems;
  }

  protected _shouldEmbed(apiItemKind: ApiItemKind): boolean {
    switch (apiItemKind) {
      case ApiItemKind.Class:
      case ApiItemKind.Package:
      case ApiItemKind.Interface:
      case ApiItemKind.Enum:
      case ApiItemKind.Namespace:
        return false;
    }
    return true;
  }

  private _generateYamlItem(apiItem: ApiDocumentedItem): IYamlItem | undefined {
    // Filter out known items that are not yet supported
    switch (apiItem.kind) {
      case ApiItemKind.CallSignature:
      case ApiItemKind.ConstructSignature:
      case ApiItemKind.IndexSignature:
      case ApiItemKind.TypeAlias:
      case ApiItemKind.Variable:
        return undefined;
    }

    const yamlItem: Partial<IYamlItem> = { };
    yamlItem.uid = this._getUid(apiItem);

    if (apiItem.tsdocComment) {
      const tsdocComment: DocComment = apiItem.tsdocComment;
      if (tsdocComment.summarySection) {
        const summary: string = this._renderMarkdown(tsdocComment.summarySection, apiItem);
        if (summary) {
          yamlItem.summary = summary;
        }
      }

      if (tsdocComment.remarksBlock) {
        const remarks: string = this._renderMarkdown(tsdocComment.remarksBlock.content, apiItem);
        if (remarks) {
          yamlItem.remarks = remarks;
        }
      }

      if (tsdocComment.deprecatedBlock) {
        const deprecatedMessage: string = this._renderMarkdown(tsdocComment.deprecatedBlock.content, apiItem);
        if (deprecatedMessage.length > 0) {
          yamlItem.deprecated = { content: deprecatedMessage };
        }
      }
    }

    if (ApiReleaseTagMixin.isBaseClassOf(apiItem)) {
      if (apiItem.releaseTag === ReleaseTag.Beta) {
        yamlItem.isPreview = true;
      }
    }

    yamlItem.name = this._getYamlItemName(apiItem);

    yamlItem.fullName = yamlItem.name;
    yamlItem.langs = [ 'typeScript' ];

    switch (apiItem.kind) {
      case ApiItemKind.Enum:
        yamlItem.type = 'enum';
        break;
      case ApiItemKind.EnumMember:
        yamlItem.type = 'field';
        const enumMember: ApiEnumMember = apiItem as ApiEnumMember;

        if (enumMember.initializerExcerpt.text.length > 0) {
          yamlItem.numericValue = enumMember.initializerExcerpt.text;
        }

        break;
      case ApiItemKind.Class:
        yamlItem.type = 'class';
        this._populateYamlClassOrInterface(yamlItem, apiItem as ApiClass);
        break;
      case ApiItemKind.Interface:
        yamlItem.type = 'interface';
        this._populateYamlClassOrInterface(yamlItem, apiItem as ApiInterface);
        break;
      case ApiItemKind.Method:
      case ApiItemKind.MethodSignature:
        yamlItem.type = 'method';
        this._populateYamlFunctionLike(yamlItem, apiItem as ApiMethod | ApiMethodSignature);
        break;

      case ApiItemKind.Constructor:
        yamlItem.type = 'constructor';
        this._populateYamlFunctionLike(yamlItem, apiItem as ApiConstructor);
        break;

      case ApiItemKind.Package:
        yamlItem.type = 'package';
        break;
      case ApiItemKind.Namespace:
        yamlItem.type = 'namespace';
        break;
      case ApiItemKind.Property:
      case ApiItemKind.PropertySignature:
        const apiProperty: ApiPropertyItem = apiItem as ApiPropertyItem;
        if (apiProperty.isEventProperty) {
          yamlItem.type = 'event';
        } else {
          yamlItem.type = 'property';
        }
        this._populateYamlProperty(yamlItem, apiProperty);
        break;

      case ApiItemKind.Function:
        yamlItem.type = 'function';
        this._populateYamlFunctionLike(yamlItem, apiItem as ApiFunction);
        break;

      default:
        throw new Error('Unimplemented item kind: ' + apiItem.kind);
    }

    if (apiItem.kind !== ApiItemKind.Package && !this._shouldEmbed(apiItem.kind)) {
      const associatedPackage: ApiPackage | undefined = apiItem.getAssociatedPackage();
      if (!associatedPackage) {
        throw new Error('Unable to determine associated package for ' + apiItem.displayName);
      }
      yamlItem.package = this._getUid(associatedPackage);
    }

    return yamlItem as IYamlItem;
  }

  private _populateYamlTypeParameters(apiItem: ApiTypeParameterListMixin): IYamlParameter[] {
    const typeParameters: IYamlParameter[] = [];
    for (const apiTypeParameter of apiItem.typeParameters) {
      const typeParameter: IYamlParameter = {
        id: apiTypeParameter.name
      };

      if (apiTypeParameter.tsdocTypeParamBlock) {
        typeParameter.description = this._renderMarkdown(apiTypeParameter.tsdocTypeParamBlock.content, apiItem);
      }

      if (!apiTypeParameter.constraintExcerpt.isEmpty) {
        typeParameter.type = [ this._renderType(apiTypeParameter.constraintExcerpt) ];
      }

      typeParameters.push(typeParameter);
    }
    return typeParameters;
  }

  private _populateYamlClassOrInterface(yamlItem: Partial<IYamlItem>, apiItem: ApiClass | ApiInterface): void {
    if (apiItem instanceof ApiClass) {
      if (apiItem.extendsType) {
        yamlItem.extends = [ this._renderType(apiItem.extendsType.excerpt) ];
      }
      if (apiItem.implementsTypes.length > 0) {
        yamlItem.implements = [];
        for (const implementsType of apiItem.implementsTypes) {
          yamlItem.implements.push(this._renderType(implementsType.excerpt));
        }
      }
    } else if (apiItem instanceof ApiInterface) {
      if (apiItem.extendsTypes.length > 0) {
        yamlItem.extends = [];
        for (const extendsType of apiItem.extendsTypes) {
          yamlItem.extends.push(this._renderType(extendsType.excerpt));
        }
      }

      const typeParameters: IYamlParameter[] = this._populateYamlTypeParameters(apiItem);
      if (typeParameters.length) {
        yamlItem.syntax = { typeParameters };
      }
    }

    if (apiItem.tsdocComment) {
      if (apiItem.tsdocComment.modifierTagSet.isSealed()) {
        let sealedMessage: string;
        if (apiItem.kind === ApiItemKind.Class) {
          sealedMessage = 'This class is marked as `@sealed`. Subclasses should not extend it.';
        } else {
          sealedMessage = 'This interface is marked as `@sealed`. Other interfaces should not extend it.';
        }
        if (!yamlItem.remarks) {
          yamlItem.remarks = sealedMessage;
        } else {
          yamlItem.remarks = sealedMessage + '\n\n' + yamlItem.remarks;
        }
      }
    }
  }

  private _populateYamlFunctionLike(yamlItem: Partial<IYamlItem>, apiItem: ApiMethod | ApiMethodSignature
    | ApiConstructor | ApiFunction): void {

    const syntax: IYamlSyntax = {
      content: apiItem.getExcerptWithModifiers()
    };
    yamlItem.syntax = syntax;

    if (ApiReturnTypeMixin.isBaseClassOf(apiItem)) {
      const returnType: string = this._renderType(apiItem.returnTypeExcerpt);

      let returnDescription: string = '';

      if (apiItem.tsdocComment && apiItem.tsdocComment.returnsBlock) {
        returnDescription = this._renderMarkdown(apiItem.tsdocComment.returnsBlock.content, apiItem);
        // temporary workaround for people who mistakenly add a hyphen, e.g. "@returns - blah"
        returnDescription = returnDescription.replace(/^\s*-\s+/, '');
      }

      if (returnType || returnDescription) {
        syntax.return = {
          type: [ returnType ],
          description: returnDescription
        };
      }
    }

    const parameters: IYamlParameter[] = [];
    for (const apiParameter of apiItem.parameters) {
      let parameterDescription: string = '';
      if (apiParameter.tsdocParamBlock) {
        parameterDescription = this._renderMarkdown(apiParameter.tsdocParamBlock.content, apiItem);
      }

      parameters.push(
        {
           id: apiParameter.name,
           description:  parameterDescription,
           type: [ this._renderType(apiParameter.parameterTypeExcerpt) ]
        } as IYamlParameter
      );
    }

    if (parameters.length) {
      syntax.parameters = parameters;
    }

    if (ApiTypeParameterListMixin.isBaseClassOf(apiItem)) {
      const typeParameters: IYamlParameter[] = this._populateYamlTypeParameters(apiItem);
      if (typeParameters.length) {
        syntax.typeParameters = typeParameters;
      }
    }

  }

  private _populateYamlProperty(yamlItem: Partial<IYamlItem>, apiItem: ApiPropertyItem): void {
    const syntax: IYamlSyntax = {
      content: apiItem.getExcerptWithModifiers()
    };
    yamlItem.syntax = syntax;

    if (apiItem.propertyTypeExcerpt.text) {
      syntax.return = {
        type: [ this._renderType(apiItem.propertyTypeExcerpt) ]
      };
    }
  }

  private _renderMarkdown(docSection: DocSection, contextApiItem: ApiItem): string {
    const stringBuilder: StringBuilder = new StringBuilder();

    this._markdownEmitter.emit(stringBuilder, docSection, {
      contextApiItem,
      onGetFilenameForApiItem: (apiItem: ApiItem) => {
        // NOTE: GitHub's markdown renderer does not resolve relative hyperlinks correctly
        // unless they start with "./" or "../".
        return `xref:${this._getUid(apiItem)}`;
      }
    });

    return stringBuilder.toString().trim();
  }

  private _writeYamlFile(dataObject: {}, filePath: string, yamlMimeType: string,
    schema: JsonSchema|undefined): void {

    JsonFile.validateNoUndefinedMembers(dataObject);

    let stringified: string = yaml.safeDump(dataObject, {
      lineWidth: 120
    });

    if (yamlMimeType) {
      stringified = `### YamlMime:${yamlMimeType}\n` + stringified;
    }

    FileSystem.writeFile(filePath, stringified, {
      convertLineEndings: NewlineKind.CrLf,
      ensureFolderExists: true
    });

    if (schema) {
      schema.validateObject(dataObject, filePath);
    }
  }

  /**
   * Calculate the DocFX "uid" for the ApiItem
   * Example:  node-core-library.JsonFile.load
   */
  protected _getUid(apiItem: ApiItem): string {
    const apiItemData: IApiItemData | undefined = this._apiItemData.get(apiItem);
    if (apiItemData) {
      return apiItemData.uid;
    }
    return this._generateUid(apiItem);
  }

  private _generateUid(apiItem: ApiItem): string {
    let result: string = '';
    for (const hierarchyItem of apiItem.getHierarchy()) {

      // For overloaded methods, add a suffix such as "MyClass.myMethod_2".
      let qualifiedName: string = hierarchyItem.displayName;
      if (ApiParameterListMixin.isBaseClassOf(hierarchyItem)) {
        if (hierarchyItem.overloadIndex > 1) {
          // Subtract one for compatibility with earlier releases of API Documenter.
          // (This will get revamped when we fix GitHub issue #1308)
          qualifiedName += `_${hierarchyItem.overloadIndex - 1}`;
        }
      }

      switch (hierarchyItem.kind) {
        case ApiItemKind.Model:
        case ApiItemKind.EntryPoint:
          break;
        case ApiItemKind.Package:
          result += PackageName.getUnscopedName(hierarchyItem.displayName);
          break;
        default:
          result += '.';
          result += qualifiedName;
          break;
      }
    }
    return result;
  }

  /**
   * Gets the unambiguous name of an item to display in a table of contents.
   */
  protected getUnambiguousTocDisplayName(apiItem: ApiItem): string {
    const apiItemData: IApiItemData | undefined = this._apiItemData.get(apiItem);
    if (apiItemData) {
      return apiItemData.unambiguousTocDisplayName;
    }
    return this._generateTocDisplayName(apiItem);
  }

  /**
   * Gets the name of an item to display in a table of contents.
   */
  protected getPossiblyAmbiguousTocDisplayName(apiItem: ApiItem): string {
    const apiItemData: IApiItemData | undefined = this._apiItemData.get(apiItem);
    if (apiItemData) {
      return apiItemData.possiblyAmbiguousTocDisplayName;
    }
    return this._generateTocDisplayName(apiItem);
  }

  private _generateTocDisplayName(apiItem: ApiItem): string {
    if (apiItem.kind === ApiItemKind.Package) {
      return PackageName.getUnscopedName(apiItem.displayName);
    }
    if (apiItem.kind === ApiItemKind.Namespace) {
      return apiItem.getScopedNameWithinPackage();
    }
    return apiItem.displayName;
  }

  private _initApiItemData(): ReadonlyMap<ApiItem, IApiItemData> {
    const apiItemData: Map<ApiItem, Partial<IApiItemData>> = new Map<ApiItem, Partial<IApiItemData>>();
    const uids: Map<string, Set<ApiItem>> = new Map<string, Set<ApiItem>>();
    const scopedNames: Map<ApiItem, Map<string, Set<ApiItem>>> = new Map<ApiItem, Map<string, Set<ApiItem>>>();
    const stack: ApiItem[] = [...this._apiModel.members];

    while (stack.length) {
      // Non-nullable assertion because we've already checked length.
      const apiItem: ApiItem = stack.shift()!;
      let localNames: Map<string, Set<ApiItem>> | undefined = scopedNames.get(apiItem.parent!);
      if (!localNames) {
        scopedNames.set(apiItem.parent!, localNames = new Map<string, Set<ApiItem>>());
      }

      const displayName: string = this._generateTocDisplayName(apiItem);
      setApiItemData(apiItemData, apiItem, 'possiblyAmbiguousTocDisplayName', displayName);
      multiMapAdd(localNames, displayName, apiItem);
      multiMapAdd(uids, this._generateUid(apiItem), apiItem);

      if (apiItem.kind === ApiItemKind.Package) {
        stack.unshift(...apiItem.members[0].members);
      } else {
        stack.unshift(...apiItem.members);
      }
    }

    disambiguate(uids, apiItemData, 'uid', disambiguateUid);

    for (const localNames of scopedNames.values()) {
      for (const apiItems of localNames.values()) {
        if (apiItems.size > 1) {
          const collisions: Set<string> = new Set<string>();
          for (const apiItem of apiItems) {
            // All ApiItems will be present in 'apiItemData' at this point.
            // Every ApiItem will have a 'uid' at this point.
            collisions.add(apiItemData.get(apiItem)!.uid!);
          }
          for (const apiItem of apiItems) {
            setApiItemData(apiItemData, apiItem, 'collisions', collisions);
          }
        }
      }

      disambiguate(localNames, apiItemData, 'unambiguousTocDisplayName', disambiguateTocDisplayName);
    }

    for (const [apiItem, { uid }] of apiItemData) {
      this._apiItemsByUid.set(uid!, apiItem);
    }

    return apiItemData as ReadonlyMap<ApiItem, IApiItemData>;
  }

  /**
   * Initialize the _apiItemsByTypeName data structure.
   */
  private _initApiItemsByTypeName(): void {
    // Collect the _apiItemsByTypeName table
    const ambiguousNames: Set<string> = new Set<string>();

    this._initApiItemsByTypeNameRecursive(this._apiModel, ambiguousNames);

    // Remove the ambiguous matches
    for (const ambiguousName of ambiguousNames) {
      this._apiItemsByTypeName.delete(ambiguousName);
    }
  }

  /**
   * Helper for _initApiItemsByTypeName()
   */
  private _initApiItemsByTypeNameRecursive(apiItem: ApiItem, ambiguousNames: Set<string>): void {
    switch (apiItem.kind) {
      case ApiItemKind.Class:
      case ApiItemKind.Enum:
      case ApiItemKind.Interface:
        // Attempt to register both the fully qualified name and the short name
        const namesForType: string[] = [apiItem.displayName];

        // Note that nameWithDot cannot conflict with apiItem.name (because apiItem.name
        // cannot contain a dot)
        const nameWithDot: string | undefined = this._getTypeNameWithDot(apiItem);
        if (nameWithDot) {
          namesForType.push(nameWithDot);
        }

        // Register all names
        for (const typeName of namesForType) {
          if (ambiguousNames.has(typeName)) {
            break;
          }

          if (this._apiItemsByTypeName.has(typeName)) {
            // We saw this name before, so it's an ambiguous match
            ambiguousNames.add(typeName);
            break;
          }

          this._apiItemsByTypeName.set(typeName, apiItem);
        }

        break;
    }

    // Recurse container members
    if (ApiItemContainerMixin.isBaseClassOf(apiItem)) {
      for (const apiMember of apiItem.members) {
        this._initApiItemsByTypeNameRecursive(apiMember, ambiguousNames);
      }
    }
  }

  private _ensureYamlReferences(): IYamlReferenceData {
    if (!this._yamlReferenceData) {
      this._yamlReferenceData = {
        references: [],
        recordedUids: new Set(),
        excerptToUidMap: new Map(),
        anonymousTypeCounter: 0
      };
    }
    return this._yamlReferenceData;
  }

  /**
   * This is a temporary workaround to enable limited autolinking of API item types
   * until the YAML file format is enhanced to support general hyperlinks.
   * @remarks
   * In the current version, fields such as IApiProperty.type allow either:
   * (1) a UID identifier such as "node-core-library.JsonFile" which will be rendered
   * as a hyperlink to that type name, or (2) a block of freeform text that must not
   * contain any Markdown links.  The _substituteUidForSimpleType() function assumes
   * it is given #2 but substitutes #1 if the name can be matched to a ApiItem.
   */
  private _linkToUidIfPossible(typeName: string): string {
    typeName = typeName.trim();
    // Do not look up the UID for a type parameter, as we could inadvertently
    // look up a different type with the same name.
    if (this._knownTypeParameters && this._knownTypeParameters.has(typeName)) {
      // DocFX gives type parameters the uid '{name}', per
      // https://dotnet.github.io/docfx/spec/metadata_dotnet_spec.html#22-spec-identifiers
      return `{${typeName}}`;
    }

    // Note that typeName might be a _getTypeNameWithDot() name or it might be a simple class name
    const apiItem: ApiItem | undefined = this._apiItemsByTypeName.get(typeName);
    if (apiItem) {
      // Substitute the UID
      return this._getUid(apiItem);
    } else {
      return typeName;
    }
  }

  private _renderType(typeExcerpt: Excerpt): string {
    const excerptTokens: ExcerptToken[] = typeExcerpt.tokens.slice(
      typeExcerpt.tokenRange.startIndex,
      typeExcerpt.tokenRange.endIndex);

    if (excerptTokens.length === 0) {
      return '';
    }

    // Remove the last token if it consists only of whitespace
    const lastToken: ExcerptToken = excerptTokens[excerptTokens.length - 1];
    if (lastToken.kind === ExcerptTokenKind.Content && !lastToken.text.trim()) {
      excerptTokens.pop();
      if (excerptTokens.length === 0) {
        return '';
      }
    }

    const yamlReferences: IYamlReferenceData = this._ensureYamlReferences();
    const typeName: string = typeExcerpt.text.trim();

    let uid: string | undefined = yamlReferences.excerptToUidMap.get(typeName);
    if (!uid) {
      const firstToken: ExcerptToken = excerptTokens[0];
      if (excerptTokens.length === 1) {
        uid = this._linkToUidIfPossible(firstToken.text);
        if (firstToken.kind === ExcerptTokenKind.Reference) {
          this._recordYamlReference(uid, typeName);
        } else {
          yamlReferences.excerptToUidMap.set(typeName, uid);
        }
        return uid;
      }

      // We've already read the first token, so start with the second one
      let pos: number = 1;
      if (firstToken.kind === ExcerptTokenKind.Reference) {
        // Skip past qualified names
        while (nextTokenIsQualifiedName(pos)) {
          pos += 2;
        }

        if (pos === excerptTokens.length) {
          // We can use _linkToUidIfPossible() on a type that is purely a qualified name
          uid = this._linkToUidIfPossible(typeName);
          this._recordYamlReference(uid, typeName); // no need to record the spec for a dotted type.
          return uid;
        }

        if (remainingTokensAreAllowedInGenericReference(pos)) {
          // DocFX UIDs use `{}` to encode generics rather than `<>`.
          // Whitespace is not allowed, so replace space between word boundaries with '-'
          // and remove all other whitespace.
          const prefix: string = new Excerpt(excerptTokens, { startIndex: 0, endIndex: pos }).text;
          const suffix: string = new Excerpt(excerptTokens, { startIndex: pos, endIndex: excerptTokens.length }).text;
          uid = this._linkToUidIfPossible(prefix).replace(/\s+/g, '') + suffix
            .replace(/[<>]/g, s => s === '<' ? '{' : '}')
            .replace(/\b\s+\b/g, '-')
            .replace(/\s+/g, '');
        }
      }

      if (!uid) {
        // ensure the uid is locally unique (within the current yaml file)
        do {
          uid = `anonymous${yamlReferences.anonymousTypeCounter++}:local`;
        }
        while (yamlReferences.recordedUids.has(uid));
      }

      this._recordYamlReference(uid, typeName, excerptTokens);
    }

    return uid;

    function nextTokenIsQualifiedName(pos: number): boolean {
      // scans ahead to see if the next two tokens are '.' and a Reference
      return pos + 1 < excerptTokens.length &&
        excerptTokens[pos].kind === ExcerptTokenKind.Content &&
        excerptTokens[pos].text.trim() === '.' &&
        excerptTokens[pos + 1].kind === ExcerptTokenKind.Reference;
    }

    function remainingTokensAreAllowedInGenericReference(pos: number): boolean {
      // If the remainder of the excerpt tokens consist only of word characters,
      // numbers following a word character, dot, comma, angle brackets, or
      // a balanced pair of open and close square brackets, then this is a generic
      // type reference.
      // Examples:
      // - A<B, C>
      // - A[]
      // - A<B1<C>[]>
      while (pos < excerptTokens.length) {
        const token: ExcerptToken = excerptTokens[pos++];
        if (token.kind === ExcerptTokenKind.Reference) {
          continue;
        }
        if (!/^([\s.,<>]|((?!\d)\w)+\d*|\[\])+$/.test(token.text)) {
          return false;
        }
      }
      return true;
    }
  }

  private _recordYamlReference(uid: string, typeName: string, excerptTokens?: ExcerptToken[]): void {
    const yamlReferences: IYamlReferenceData = this._ensureYamlReferences();
    yamlReferences.excerptToUidMap.set(typeName, uid);

    // Do not record a yaml reference if we've already recorded one for this uid.
    if (!yamlReferences.recordedUids.has(uid)) {
      // Fill in the reference spec from the excerpt.
      const spec: IYamlReferenceSpec[] = [];
      if (excerptTokens) {
        for (const token of excerptTokens) {
          if (token.kind === ExcerptTokenKind.Reference) {
            const apiItem: ApiItem | undefined = this._apiItemsByTypeName.get(token.text);
            spec.push(
              {
                uid: apiItem ? this._getUid(apiItem) : token.text,
                name: token.text,
                fullName: apiItem ? apiItem.getScopedNameWithinPackage() : token.text
              }
            );
          } else {
            spec.push(
              {
                name: token.text,
                fullName: token.text
              }
            );
          }
        }
      }

      const yamlReference: IYamlReference = { uid };
      if (spec.length > 0) {
        yamlReference['name.typeScript'] = spec.map(s => s.name).join('').trim();
        yamlReference['fullName.typeScript'] = spec.map(s => s.fullName || s.name).join('').trim();
        yamlReference['spec.typeScript'] = spec;
      } else if (typeName !== uid) {
        yamlReference.name = typeName;
      }

      yamlReferences.references.push(yamlReference);
      yamlReferences.recordedUids.add(uid);
    }
  }

  /**
   * If the apiItem represents a scoped name such as "my-library#MyNamespace.MyClass",
   * this returns a string such as "MyNamespace.MyClass".  If the result would not
   * have at least one dot in it, then undefined is returned.
   */
  private _getTypeNameWithDot(apiItem: ApiItem): string | undefined {
    const result: string = apiItem.getScopedNameWithinPackage();
    if (result.indexOf('.') >= 0) {
      return result;
    }
    return undefined;
  }

  private _getYamlItemName(apiItem: ApiItem): string {
    if (apiItem.parent && apiItem.parent.kind === ApiItemKind.Namespace) {
      // For members a namespace, show the full name excluding the package part:
      // Example: excel.Excel.Binding --> Excel.Binding
      return this._getUid(apiItem).replace(/^[^.]+\./, '');
    }
    return Utilities.getConciseSignature(apiItem);
  }

  private _getYamlFilePath(apiItem: ApiItem): string {
    let result: string = '';

    for (const current of apiItem.getHierarchy()) {
      switch (current.kind) {
        case ApiItemKind.Model:
        case ApiItemKind.EntryPoint:
          break;
        case ApiItemKind.Package:
          result += PackageName.getUnscopedName(current.displayName);
          break;
        default:
          if (current.parent && current.parent.kind === ApiItemKind.EntryPoint) {
            result += '/';
          } else {
            result += '.';
          }
          result += current.displayName;
          break;
      }
    }
    return path.join(this._outputFolder, result.toLowerCase() + '.yml');
  }

  private _deleteOldOutputFiles(): void {
    console.log('Deleting old output from ' + this._outputFolder);
    FileSystem.ensureEmptyFolder(this._outputFolder);
  }
}

/**
 * Add a key and a value to a map that supports multiple values.
 */
function multiMapAdd<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  let values: Set<V> | undefined = map.get(key);
  if (!values) {
    map.set(key, values = new Set<V>());
  }
  values.add(value);
}

/**
 * Disambiguate values (either a uid or TOC entry) for ApiItems with possible collisions.
 * @param map A map from a value to one or more ApiItems that have the same value.
 * @param apiItemData A cache in which to store the unambiguous values
 * @param key The kind of value to disambiguate.
 * @param makeSuffix A callback used to generate a suffix for an ambiguous value.
 */
function disambiguate(map: Map<string, Set<ApiItem>>, apiItemData: Map<ApiItem, Partial<IApiItemData>>,
  key: keyof IApiItemData, makeSuffix: (apiItem: ApiItem, precedence: number, attempt: number) => string): void {

  // keep track of whether we've already seen a value so that we do not have duplicates.
  const seen: Set<string> = new Set<string>();
  for (const [possiblyAmbiguousValue, apiItems] of map) {
    // Calculate the highest precedence among siblings
    let precedence: number = -1;
    if (apiItems.size > 1) {
      for (const apiItem of apiItems) {
        precedence = Math.max(precedence, getDisambiguationPrecedence(apiItem));
      }
    }

    for (const apiItem of apiItems) {
      let attempt: number = 0;
      let unambiguousValue: string;
      do {
        unambiguousValue = possiblyAmbiguousValue + makeSuffix(apiItem, precedence, attempt++);
      }
      while (seen.has(unambiguousValue));
      seen.add(unambiguousValue);

      setApiItemData(apiItemData, apiItem, key, unambiguousValue);
    }
  }
}

function setApiItemData<K extends keyof IApiItemData>(apiItemData: Map<ApiItem, Partial<IApiItemData>>,
  apiItem: ApiItem, key: K, value: IApiItemData[K]): void {

  let data: Partial<IApiItemData> | undefined = apiItemData.get(apiItem);
  if (!data) {
    apiItemData.set(apiItem, data = {});
  }
  data[key] = value;
}

/**
 * Gets the precedence of an ApiItem for use when performing disambiguation.
 * The highest precedence item often avoids needing a suffix.
 */
function getDisambiguationPrecedence(apiItem: ApiItem): number {
  switch (apiItem.kind) {
    default:
      // Anything else we will always disambiguate.
      return 0;
    case ApiItemKind.Namespace:
      // Namespaces merge with everything.
      return 1;
    case ApiItemKind.Interface:
    case ApiItemKind.TypeAlias:
      // Interfaces and TypeAliases both exist in type-space and cannot collide with each other.
      return 2;
    case ApiItemKind.Class:
    case ApiItemKind.Function:
    case ApiItemKind.Enum:
    case ApiItemKind.Variable:
      // Classes, Functions, Enums, and Variables all exist in value-space and cannot collide with each other.
      return 3;
  }
}

/**
 * Generates a suffix to disambiguate one uid from another. If `highestPrecedence` is -1, it means there was only
 * one item.
 *
 * A suffix will *not* be added if the item has the highest precedence among its siblings. The precedence is:
 * 1. Classes, Functions, Enums, Variables
 * 2. Interfaces, TypeAliases
 * 3. Namespaces
 *
 * If a class, an interface, and a namespace all have the same uid ('MyService'), it will generate the following:
 * - ApiClass: 'MyService'
 * - ApiInterface: 'MyService:interface'
 * - ApiNamespace: 'MyService:namespace'
 *
 * If an interface and a namespace both have the same uid ('MyService'), it will generate the following:
 * - ApiInterface: 'MyService'
 * - ApiNamespace: 'MyService:namespace'
 *
 * If there is somehow *still* a collision, `attempt` will be non-zero and appended as a suffix:
 * - 'ambiguousUid'
 * - 'ambiguousUid_2'
 * - 'ambiguousUid_3'
 *
 * However, it is unlikely that such a case will be hit.
 */
function disambiguateUid(item: ApiItem, highestPrecedence: number, attempt: number): string {
  let suffix: string = '';
  if (getDisambiguationPrecedence(item) < highestPrecedence) {
    suffix += `:${item.kind.toLowerCase()}`;
  }
  if (attempt > 0) {
    suffix += `_${attempt + 1}`;
  }
  return suffix;
}

/**
 * Generates a suffix to disambiguate one TOC display name from another. If `highestPrecedence` is -1, it means there
 * was only one item.
 *
 * For example, if an interface and a class both have the same display name, it will generate the following for each:
 * - ApiClass: 'AmbiguousName (Class)'
 * - ApiNamespace: 'AmbiguousName (Namespace)'
 *
 * If there is somehow *still* a collision, `attempt` will be non-zero and appended as a suffix:
 * - 'AmbiguousName (Class)'
 * - 'ambiguousName (Class) (2)'
 * - 'ambiguousName (Class) (3)'
 *
 * However, it is unlikely that such a case will be hit.
 */
function disambiguateTocDisplayName(item: ApiItem, highestPrecedence: number, attempt: number): string {
  let suffix: string = '';
  if (highestPrecedence >= 0) {
    suffix += ` (${item.kind})`;
  }
  if (attempt > 0) {
    suffix += ` (${attempt + 1})`;
  }
  return suffix;
}
