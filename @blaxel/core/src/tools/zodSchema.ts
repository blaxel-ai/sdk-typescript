import z from "zod";

const jsonTypeToZod = (type: string, param: FunctionSchema): z.ZodType => {
  switch (type) {
    case "boolean":
      return z.boolean();
    case "number":
    case "integer":
      return z.number();
    case "null":
      return z.null();
    case "array":
      return z.array(schemaToZodSchema(param.items || {}));
    case "object":
      return schemaToZodSchema(param);
    default:
      return z.string();
  }
};

/**
 * Converts an array of `FunctionSchema` objects into a Zod schema for validation.
 *
 * @param {FunctionSchema} parameters - The parameters to convert.
 * @returns {z.ZodObject<any>} A Zod object schema representing the parameters.
 */
export const schemaToZodSchema = (schema: FunctionSchema): z.ZodObject<any> => {
  const shape: { [key: string]: z.ZodType } = {};

  if (schema.properties) {
    Object.entries(schema.properties).forEach(([key, param]) => {
      let zodType: z.ZodType;

      if (Array.isArray(param.type)) {
        // Handle union types like ["null", "boolean"]
        const types = param.type.map((t) => jsonTypeToZod(t, param));
        zodType =
          types.length === 1
            ? types[0]
            : z.union(types as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
      } else {
        zodType = jsonTypeToZod(param.type ?? "string", param);
      }

      if (param.description) {
        zodType = zodType.describe(param.description);
      }
      shape[key] =
        param.required || schema.required?.includes(key)
          ? zodType
          : zodType.optional();
    });
  }
  return z.object(shape);
};

/**
* Function schema
*/
export type FunctionSchema = {
  /**
   * List of schemas that this schema extends
   */
  allOf?: Array<unknown>;
  /**
   * List of possible schemas, any of which this schema could be
   */
  anyOf?: Array<unknown>;
  /**
   * Description of the schema
   */
  description?: string;
  /**
   * Enum values
   */
  enum?: Array<string>;
  /**
   * Format of the schema
   */
  format?: string;
  items?: FunctionSchema;
  /**
   * Maximum length for string types
   */
  maxLength?: number;
  /**
   * Maximum value for number types
   */
  maximum?: number;
  /**
   * Minimum length for string types
   */
  minLength?: number;
  /**
   * Minimum value for number types
   */
  minimum?: number;
  /**
   * Schema that this schema must not be
   */
  not?: {
      [key: string]: unknown;
  };
  /**
   * List of schemas, one of which this schema must be
   */
  oneOf?: Array<unknown>;
  /**
   * Pattern for string types
   */
  pattern?: string;
  /**
   * Properties of the schema
   */
  properties?: {
      [key: string]: FunctionSchema;
  };
  /**
   * Required properties of the schema
   */
  required?: Array<string>;
  /**
   * Title of the schema
   */
  title?: string;
  /**
   * Type of the schema
   */
  type?: string | string[];
};
