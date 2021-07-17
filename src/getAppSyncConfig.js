import { AmplifyAppSyncSimulatorAuthenticationType as AuthTypes } from 'amplify-appsync-simulator';
import axios from 'axios';
import fs from 'fs';
import { forEach, isNil, first } from 'lodash';
import path from 'path';
import { mergeTypes } from 'merge-graphql-schemas';
import * as globby from 'globby';
import directLambdaRequest from './templates/direct-lambda.request.vtl';
import directLambdaResponse from './templates/direct-lambda.response.vtl';

const directLambdaMappingTemplates = {
  request: directLambdaRequest,
  response: directLambdaResponse,
};

export default function getAppSyncConfig(context, appSyncConfig) {
  // Flattening params
  const cfg = {
    ...appSyncConfig,
    mappingTemplates: (appSyncConfig.mappingTemplates || []).flat(),
    functionConfigurations: (appSyncConfig.functionConfigurations || []).flat(),
    dataSources: (appSyncConfig.dataSources || []).flat(),
  };

  const mappingTemplatesLocation = path.join(
    context.serverless.config.servicePath,
    cfg.mappingTemplatesLocation || 'mapping-templates',
  );

  const { defaultMappingTemplates = {} } = cfg;

  const getMappingTemplate = (filePath) => {
    return fs.readFileSync(path.join(mappingTemplatesLocation, filePath), {
      encoding: 'utf8',
    });
  };

  const toAbsolutePosixPath = (basePath, filePath) =>
    (path.isAbsolute(filePath)
      ? filePath
      : path.join(basePath, filePath)
    ).replace(/\\/g, '/');

  const globFilePaths = (basePath, filePaths) => {
    return filePaths
      .map((filePath) => {
        const paths = globby.sync(toAbsolutePosixPath(basePath, filePath));
        if (path.isAbsolute(filePath)) {
          return paths;
        } else {
          // For backward compatibility with FileMap, revert to relative path
          return paths.map((p) => path.relative(basePath, p));
        }
      })
      .flat();
  };

  const getFileMap = (basePath, filePath) => ({
    path: filePath,
    content: fs.readFileSync(toAbsolutePosixPath(basePath, filePath), {
      encoding: 'utf8',
    }),
  });

  const makeDataSource = (source) => {
    if (source.name === undefined || source.type === undefined) {
      return null;
    }

    const dataSource = {
      name: source.name,
      type: source.type,
    };

    switch (source.type) {
      case 'AMAZON_DYNAMODB': {
        return {
          ...dataSource,
          config: {
            ...context.options.dynamoDb,
            tableName: source.config.tableName,
          },
        };
      }
      case 'AWS_LAMBDA': {
        const { functionName } = source.config;
        if (functionName === undefined) {
          context.plugin.log(`${source.name} does not have a functionName`, {
            color: 'orange',
          });
          return null;
        }

        const conf = context.options;
        const func =
          conf.functions?.[functionName] ||
          context.serverless.service.functions?.[functionName];

        if (func === undefined) {
          context.plugin.log(`The ${functionName} function is not defined`, {
            color: 'orange',
          });
          return null;
        }

        let url, method;
        if (func.url) {
          url = func.url;
          method = func.method;
        } else {
          url = `http://localhost:${context.options.lambdaPort}/2015-03-31/functions/${func.name}/invocations`;
        }
        return {
          ...dataSource,
          invoke: async (payload) => {
            const result = await axios.request({
              url,
              method: method || 'POST',
              data: payload,
              headers: payload?.request?.headers,
              validateStatus: false,
            });
            return result.data;
          },
        };
      }
      case 'AMAZON_ELASTICSEARCH':
      case 'HTTP': {
        return {
          ...dataSource,
          endpoint: source.config.endpoint,
        };
      }
      default:
        return dataSource;
    }
  };

  const makeMappingTemplate = (resolver, type) => {
    const { name, type: parent, field, substitutions = {} } = resolver;

    const defaultTemplatePrefix = name || `${parent}.${field}`;
    const templatePath = !isNil(resolver?.[type])
      ? resolver?.[type]
      : !isNil(defaultMappingTemplates?.[type])
      ? defaultMappingTemplates?.[type]
      : `${defaultTemplatePrefix}.${type}.vtl`;

    let mappingTemplate;
    // Direct lambda
    // For direct lambdas, we use a default mapping template
    // See https://amzn.to/3ncV3Dz
    if (templatePath === false) {
      mappingTemplate = directLambdaMappingTemplates[type];
    } else {
      mappingTemplate = getMappingTemplate(templatePath);
      // Substitutions
      const allSubstitutions = { ...cfg.substitutions, ...substitutions };
      forEach(allSubstitutions, (value, variable) => {
        const regExp = new RegExp(`\\$\{?${variable}}?`, 'g');
        mappingTemplate = mappingTemplate.replace(regExp, value);
      });
    }

    return mappingTemplate;
  };

  const makeResolver = (resolver) => {
    return {
      kind: resolver.kind || 'UNIT',
      fieldName: resolver.field,
      typeName: resolver.type,
      dataSourceName: resolver.dataSource,
      functions: resolver.functions,
      requestMappingTemplate: makeMappingTemplate(resolver, 'request'),
      responseMappingTemplate: makeMappingTemplate(resolver, 'response'),
    };
  };

  const makeFunctionConfiguration = (config) => ({
    dataSourceName: config.dataSource,
    name: config.name,
    requestMappingTemplate: makeMappingTemplate(config, 'request'),
    responseMappingTemplate: makeMappingTemplate(config, 'response'),
  });

  const makeAuthType = (authType) => {
    const auth = {
      authenticationType: authType.authenticationType,
    };

    if (auth.authenticationType === AuthTypes.AMAZON_COGNITO_USER_POOLS) {
      auth.cognitoUserPoolConfig = {
        AppIdClientRegex: authType.userPoolConfig.appIdClientRegex,
      };
    } else if (auth.authenticationType === AuthTypes.OPENID_CONNECT) {
      auth.openIDConnectConfig = {
        Issuer: authType.openIdConnectConfig.issuer,
        ClientId: authType.openIdConnectConfig.clientId,
      };
    }

    return auth;
  };

  const makeAppSync = (config) => ({
    name: config.name,
    apiKey: context.options.apiKey,
    defaultAuthenticationType: makeAuthType(config),
    additionalAuthenticationProviders: (
      config.additionalAuthenticationProviders || []
    ).map(makeAuthType),
  });

  // Load the schema. If multiple provided, merge them
  const schemaPaths = Array.isArray(cfg.schema)
    ? cfg.schema
    : [cfg.schema || 'schema.graphql'];
  const basePath = context.serverless.config.servicePath;
  const schemas = globFilePaths(basePath, schemaPaths).map((schemaPath) =>
    getFileMap(basePath, schemaPath),
  );
  const schema = {
    path: first(schemas).path,
    content: mergeTypes(schemas.map((s) => s.content)),
  };

  return {
    appSync: makeAppSync(cfg),
    schema,
    resolvers: cfg.mappingTemplates.map(makeResolver),
    dataSources: cfg.dataSources.map(makeDataSource).filter((v) => v !== null),
    functions: cfg.functionConfigurations.map(makeFunctionConfiguration),
  };
}
