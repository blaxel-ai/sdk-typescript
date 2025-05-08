import z from "zod";
import { FunctionSchema } from "../client/index.js";

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
            zodType = z.number();
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