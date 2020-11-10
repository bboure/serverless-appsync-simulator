import { AmplifyAppSyncSimulatorAuthenticationType as AuthTypes } from "amplify-appsync-simulator";
import fs from "fs";
import { forEach } from "lodash";
import path from "path";
import { mergeTypes } from "merge-graphql-schemas";

export default function getAppSyncConfig(context, appSyncConfig) {
  // Flattening params
  const cfg = {
    ...appSyncConfig,
    mappingTemplates: (appSyncConfig.mappingTemplates || []).flat(),
    functionConfigurations: (appSyncConfig.functionConfigurations || []).flat(),
    dataSources: (appSyncConfig.dataSources || []).flat(),
  };

  const getFileMap = (basePath, filePath, substitutionPath = null) => ({
    path: substitutionPath || filePath,
    content: fs.readFileSync(path.join(basePath, filePath), { encoding: 'utf8' }),
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
        const {
          endpoint,
          region,
          accessKeyId,
          secretAccessKey,
        } = context.options.dynamoDb;

        return {
          ...dataSource,
          config: {
            endpoint,
            region,
            accessKeyId,
            secretAccessKey,
            tableName: source.config.tableName,
          },
        };
      }
      case 'AWS_LAMBDA': {
        const { functionName } = source.config;
        if (functionName === undefined) {
          context.plugin.log(
            `${source.name} does not have a functionName`,
            { color: 'orange' },
          );
          return null;
        }
        const func = context.serverless.service.functions[functionName];
        if (func === undefined) {
          context.plugin.log(
            `The ${functionName} function is not defined`,
            { color: 'orange' },
          );
          return null;
        }
        return {
          ...dataSource,
          invoke: (payload) => invokeHandler(functionName, context, payload),
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

  const getDefaultTemplatePrefix = (template) => {
    const { name, type, field } = template;
    return name ? `${name}` : `${type}.${field}`;
  };

  const makeResolver = (resolver) => ({
    kind: resolver.kind || 'UNIT',
    fieldName: resolver.field,
    typeName: resolver.type,
    dataSourceName: resolver.dataSource,
    functions: resolver.functions,
    requestMappingTemplateLocation: `${getDefaultTemplatePrefix(resolver)}.request.vtl`,
    responseMappingTemplateLocation: `${getDefaultTemplatePrefix(resolver)}.response.vtl`,
  });

  const makeFunctionConfiguration = (functionConfiguration) => ({
    dataSourceName: functionConfiguration.dataSource,
    name: functionConfiguration.name,
    requestMappingTemplateLocation: `${getDefaultTemplatePrefix(functionConfiguration)}.request.vtl`,
    responseMappingTemplateLocation: `${getDefaultTemplatePrefix(functionConfiguration)}.response.vtl`,
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
    additionalAuthenticationProviders: (config.additionalAuthenticationProviders || [])
      .map(makeAuthType),
  });

  const mappingTemplatesLocation = path.join(
    context.serverless.config.servicePath,
    cfg.mappingTemplatesLocation || 'mapping-templates',
  );

  const makeMappingTemplate = (filePath, substitutionPath = null, substitutions = {}) => {
    const mapping = getFileMap(mappingTemplatesLocation, filePath, substitutionPath);

    forEach(substitutions, (value, variable) => {
      const regExp = new RegExp(`\\$\{?${variable}}?`, 'g');
      mapping.content = mapping.content.replace(regExp, value);
    });

    return mapping;
  };

  const makeMappingTemplates = (config) => {
    const sources = [].concat(
      config.mappingTemplates,
      config.functionConfigurations,
    );

    return sources.reduce((acc, template) => {
      const {
        substitutions = {},
        request,
        response,
      } = template;

      const defaultTemplatePrefix = getDefaultTemplatePrefix(template);

      const requestTemplate = request || `${defaultTemplatePrefix}.request.vtl`;
      const responseTemplate = response || `${defaultTemplatePrefix}.response.vtl`;

      // Substitutions
      const allSubstitutions = { ...config.substitutions, ...substitutions };
      return [
        ...acc,
        makeMappingTemplate(requestTemplate, `${defaultTemplatePrefix}.request.vtl`, allSubstitutions),
        makeMappingTemplate(responseTemplate, `${defaultTemplatePrefix}.response.vtl`, allSubstitutions),
      ];
    }, []);
  };

  // Load the schema. If multiple provided, merge them
  const schemaPaths = Array.isArray(cfg.schema) ? cfg.schema : [cfg.schema || 'schema.graphql'];
  const schemas = schemaPaths.map(
    (schemaPath) => getFileMap(context.serverless.config.servicePath, schemaPath),
  );
  const schema = {
    path: schemas.find((s) => s.path),
    content: mergeTypes(schemas.map((s) => s.content)),
  };

  return {
    appSync: makeAppSync(cfg),
    schema,
    resolvers: cfg.mappingTemplates.map(makeResolver),
    dataSources: cfg.dataSources.map(makeDataSource).filter((v) => v !== null),
    functions: cfg.functionConfigurations.map(makeFunctionConfiguration),
    mappingTemplates: makeMappingTemplates(cfg),
  };
}

async function invokeHandler(functionName, context, event) {
  // Store deep copy of cliOptions so we can restore later
  const oldOptions = Object.assign(
    {},
    { ...context.serverless.pluginManager.cliOptions }
  );

  context.serverless.pluginManager.cliOptions["f"] = functionName;
  context.serverless.pluginManager.cliOptions["d"] = JSON.stringify(event);

  // Capture stdout temporarily
  let output = "";

  // Save original write so we can restore later
  process.stdout._orig_write = process.stdout.write;
  process.stdout.write = (data) => {
    output += data;

    process.stdout._orig_write(data);
  };

  // Run serverless invoke local
  await context.serverless.pluginManager.run(["invoke", "local"]);

  // Restore changes
  context.serverless.pluginManager.cliOptions = oldOptions;
  process.stdout.write = process.stdout._orig_write;

  let result;

  // If we can't parse it, just return watever was read
  try {
    result = JSON.parse(output);
  } catch (err) {
    result = output;
  }

  return result;
}
