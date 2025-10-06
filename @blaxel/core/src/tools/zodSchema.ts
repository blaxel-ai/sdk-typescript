import z from "zod";

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

        switch (param.type) {
          case "boolean":
            zodType = z.boolean();
            break;
          case "number":
          case "integer":
            zodType = z.number();
            break;
          case "null":
            zodType = z.null();
            break;
          case "array":
            zodType = z.array(schemaToZodSchema(param.items || {}));
            break;
          case "object":
            zodType = schemaToZodSchema(param);
            break;
          default:
            zodType = z.string();
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
  type?: string;
};
