import { arrayElements, getObjectString, JsonDocumentNode, memberName, objectMembers, stringValue } from "../jsonAst";
import { pushReference } from "./shared";
import { ResourceReference } from "./types";

export function getParticleReferences(ast: JsonDocumentNode): ResourceReference[] {
  const references: ResourceReference[] = [];

  for (const item of objectMembers(ast.body)) {
    if (memberName(item) === "textures") {
      for (const texture of arrayElements(item.value)) {
        pushReference(references, texture, "textures/particle", "particles", "png", "texture");
      }
    }
  }

  return references;
}

export function getEquipmentReferences(ast: JsonDocumentNode): ResourceReference[] {
  const references: ResourceReference[] = [];
  const layers = objectMembers(ast.body).find(member => memberName(member) === "layers");

  for (const layer of objectMembers(layers?.value)) {
    const layerName = memberName(layer);
    if (!layerName) {
      continue;
    }

    for (const layerEntry of arrayElements(layer.value)) {
      const texture = objectMembers(layerEntry).find(member => memberName(member) === "texture");
      if (texture) {
        pushReference(references, texture.value, `textures/entity/equipment/${layerName}`, "equipment", "png", "texture");
      }
    }
  }

  return references;
}

export function getFontReferences(ast: JsonDocumentNode): ResourceReference[] {
  const references: ResourceReference[] = [];
  const providers = objectMembers(ast.body).find(member => memberName(member) === "providers");

  for (const provider of arrayElements(providers?.value)) {
    const type = getObjectString(provider, "type");
    if (type === "reference") {
      const id = objectMembers(provider).find(member => memberName(member) === "id");
      if (id) {
        pushReference(references, id.value, "font", "font", "json", "font");
      }
    } else if (type === "bitmap") {
      const file = objectMembers(provider).find(member => memberName(member) === "file");
      if (file) {
        pushReference(references, file.value, "textures", "font", "png", "texture");
      }
    } else if (type === "ttf") {
      const file = objectMembers(provider).find(member => memberName(member) === "file");
      if (file) {
        pushReference(references, file.value, "font", "font", null, "fontFile");
      }
    } else if (type === "unihex") {
      const hexFile = objectMembers(provider).find(member => memberName(member) === "hex_file");
      if (hexFile) {
        pushReference(references, hexFile.value, "font", "font", null, "fontFile");
      }
    }
  }

  return references;
}

export function getWaypointStyleReferences(ast: JsonDocumentNode): ResourceReference[] {
  const references: ResourceReference[] = [];
  const sprites = objectMembers(ast.body).find(member => memberName(member) === "sprites");

  for (const sprite of arrayElements(sprites?.value)) {
    pushReference(references, sprite, "textures/gui/sprites/hud/locator_bar_dot", "waypoint_style", "png", "texture");
  }

  return references;
}

export function getPostEffectReferences(ast: JsonDocumentNode): ResourceReference[] {
  const references: ResourceReference[] = [];
  const passes = objectMembers(ast.body).find(member => memberName(member) === "passes");

  for (const pass of arrayElements(passes?.value)) {
    for (const member of objectMembers(pass)) {
      const name = memberName(member);
      if (name === "vertex_shader") {
        pushReference(references, member.value, "shaders", "post_effect", "vsh", "shader");
      } else if (name === "fragment_shader") {
        pushReference(references, member.value, "shaders", "post_effect", "fsh", "shader");
      } else if (name === "inputs") {
        for (const input of arrayElements(member.value)) {
          const location = objectMembers(input).find(inputMember => memberName(inputMember) === "location");
          if (location) {
            pushReference(references, location.value, "textures/effect", "post_effect", "png", "texture");
          }
        }
      }
    }
  }

  return references;
}

export function getSoundReferences(ast: JsonDocumentNode): ResourceReference[] {
  const references: ResourceReference[] = [];

  for (const soundEvent of objectMembers(ast.body)) {
    const sounds = objectMembers(soundEvent.value).find(member => memberName(member) === "sounds");
    for (const sound of arrayElements(sounds?.value)) {
      const directSound = stringValue(sound);
      if (directSound) {
        pushReference(references, sound, "sounds", "sounds.json", "ogg", "sound");
        continue;
      }

      const type = getObjectString(sound, "type");
      if (type === "event") {
        continue;
      }

      const name = objectMembers(sound).find(member => memberName(member) === "name");
      if (name) {
        pushReference(references, name.value, "sounds", "sounds.json", "ogg", "sound");
      }
    }
  }

  return references;
}
